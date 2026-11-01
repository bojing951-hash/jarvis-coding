/**
 * B03-QA-01/02/03：Docker inspect 异常输出不得被转换成可信 gone/停止。
 *
 * 使用真实 production sh()/killContainer() 调用链，Docker CLI 用受控 fake
 * 注入正常状态、正常 No such object、No such object 后 timeout/signal、
 * 部分输出后 timeout、未知状态、daemon 失联等。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-b03-'));
const fakeDocker = join(tmp, 'docker-fake.sh');
writeFileSync(fakeDocker, `#!/bin/sh
mode="\${FAKE_DOCKER_MODE:-ok}"
case "$1" in
  info)
    echo "29.9.2"; exit 0 ;;
  image)
    echo "sha256:fake"; exit 0 ;;
  network)
    echo "true"; exit 0 ;;
  kill)
    if [ "$2" = "--signal" ] && [ "$3" = "TERM" ]; then
      [ "$mode" = "term_fail" ] && exit 1
    fi
    exit 0 ;;
  inspect)
    case "$mode" in
      running) echo "running"; exit 0 ;;
      exited) echo "exited"; exit 0 ;;
      dead) echo "dead"; exit 0 ;;
      term_fail) echo "exited"; exit 0 ;;
      removing) echo "removing"; exit 0 ;;
      no_such) echo "Error: No such object: $2" >&2; exit 1 ;;
      no_such_timeout|term_fail_no_such_timeout)
        echo "Error: No such object: $2" >&2; sleep 5 ;;
      no_such_signal)
        echo "Error: No such object: $2" >&2; kill -TERM $$ ;;
      partial_stdout_timeout)
        echo "partial stdout"; sleep 5 ;;
      partial_stderr_timeout)
        echo "partial stderr" >&2; sleep 5 ;;
      unknown) echo "weird-state"; exit 0 ;;
      mismatch) echo "Error: No such object: another-container" >&2; exit 1 ;;
      daemon) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
      *) echo "Error: unknown test mode" >&2; exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`);
chmodSync(fakeDocker, 0o755);
process.env.JARVIS_DOCKER_BIN = fakeDocker;
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');

const iso = await import('../src/isolation.mjs');
const svc = await import('../src/service.mjs');

const call = (mode, opts = {}) => {
  process.env.FAKE_DOCKER_MODE = mode;
  return iso.killContainer('b03-target', { graceMs: 100, killTimeoutMs: 100, inspectTimeoutMs: 100, pollMs: 10, ...opts });
};

test('B03-QA-01 No such object 后超时不得 confirmed', async () => {
  const r = await call('no_such_timeout');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 No such object 后被信号终止不得 confirmed', async () => {
  const r = await call('no_such_signal');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 部分 stdout 后超时不得 confirmed', async () => {
  const r = await call('partial_stdout_timeout');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 部分 stderr 后超时不得 confirmed', async () => {
  const r = await call('partial_stderr_timeout');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 正常非零 No such object 仍可识别 gone', async () => {
  const r = await call('no_such');
  assert.equal(r.confirmed, true, JSON.stringify(r));
  assert.equal(r.state, 'gone');
  assert.equal(r.killAccepted, true);
});

test('B03-QA-01 不匹配目标容器的 No such object 不得 confirmed', async () => {
  const r = await call('mismatch');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 正常 running 不得 confirmed', async () => {
  const r = await call('running', { graceMs: 100 });
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 正常 exited 可确认停止', async () => {
  const r = await call('exited');
  assert.equal(r.confirmed, true, JSON.stringify(r));
  assert.equal(r.state, 'exited');
});

test('B03-QA-01 dead/removing 可确认停止', async () => {
  const dead = await call('dead');
  assert.equal(dead.confirmed, true, JSON.stringify(dead));
  const removing = await call('removing');
  assert.equal(removing.confirmed, true, JSON.stringify(removing));
});

test('B03-QA-01 未知状态不得 confirmed', async () => {
  const r = await call('unknown');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 daemon 失联不得 confirmed', async () => {
  const r = await call('daemon');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});

test('B03-QA-01 TERM 失败但独立 exited 证据可确认', async () => {
  const r = await call('term_fail', { graceMs: 100 });
  assert.equal(r.killAccepted, false, JSON.stringify(r));
  assert.equal(r.confirmed, true, 'exited 是独立可信停止证据');
  assert.equal(r.state, 'exited');
});

test('B03-QA-01 KILL 后 inspect 仍异常不得 confirmed', async () => {
  const r = await call('term_fail_no_such_timeout');
  assert.equal(r.confirmed, false, JSON.stringify(r));
});


test('B03-QA-03 不可信 inspect 沿 killContainer→settle→cancelTask 传播时不得取消成功', async () => {
  const p = svc.createProject({ name: 'b03chain', slug: `b03chain-${Date.now().toString(36)}` });
  const t = svc.createTask({ project: p.id, title: 'chain', input: 'x' });
  svc.updateTask(t.id, { status: 'running' });
  const execId = `exe_b03chain_${Date.now().toString(36)}`;
  svc.db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, t.id, null, 'running', 'test', '', new Date().toISOString());
  svc.db()
    .prepare("INSERT INTO execution_resources (id,execution_id,task_id,kind,name,state,started_at) VALUES (?,?,?,?,?,?,?)")
    .run(`res_${execId}`, execId, t.id, 'claude', `jarvis-exec-${execId}`, 'started', new Date().toISOString());

  process.env.FAKE_DOCKER_MODE = 'no_such_timeout';
  const r = await svc.cancelTask(t.id, {
    isolation: iso,
    launchWaitMs: 200,
    killOptions: { graceMs: 50, killTimeoutMs: 50, inspectTimeoutMs: 50, pollMs: 10 }
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(svc.getTask(t.id).status, 'cancel_requested');
  const execution = svc.db().prepare('SELECT * FROM executions WHERE id=?').get(execId);
  assert.equal(execution.status, 'running');
  const resource = svc.listResources(t.id)[0];
  assert.equal(resource.state, 'unknown');
});
