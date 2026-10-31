/**
 * DEF-01/02/03：用可控 docker 替身做失败注入。
 * 不依赖真实 Docker 状态，能确定性地区分「容器消失 / daemon 失联 / 容器仍在 / 网络非内部」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-docker-fake-'));
// 必须隔离状态库，避免污染真实数据
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');
const fakeDocker = join(tmp, 'docker-fake.sh');
const callLog = join(tmp, 'calls.log');

writeFileSync(
  fakeDocker,
  `#!/bin/sh
echo "$@" >> "${'$'}{FAKE_LOG}"
mode="\${FAKE_MODE:-ok}"
case "$1" in
  info)
    [ "$mode" = "daemon_down" ] && { echo "Cannot connect to the Docker daemon"; exit 1; }
    echo "29.9.2"; exit 0 ;;
  network)
    [ "$mode" = "internal_false" ] && { echo "false"; exit 0; }
    [ "$mode" = "no_network" ] && { echo "Error: No such network"; exit 1; }
    echo "true"; exit 0 ;;
  image)
    echo "sha256:fake"; exit 0 ;;
  kill)
    [ "$mode" = "daemon_down" ] && { echo "Cannot connect to the Docker daemon"; exit 1; }
    exit 0 ;;
  inspect)
    [ "$mode" = "stuck" ] && { echo "running"; exit 0; }
    [ "$mode" = "daemon_down" ] && { echo "Cannot connect to the Docker daemon"; exit 1; }
    echo "Error: No such object: x"; exit 1 ;;
  run)
    exit 0 ;;
  *)
    exit 0 ;;
esac
`,
  { mode: 0o755 }
);
chmodSync(fakeDocker, 0o755);

function loadIsolation(mode, tag) {
  process.env.JARVIS_DOCKER_BIN = fakeDocker;
  process.env.JARVIS_EXECUTOR_IMAGE = 'fake-image:1';
  process.env.JARVIS_EXECUTOR_NETWORK = 'fake-internal';
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = callLog;
  return import(`../src/isolation.mjs?${tag}`);
}

/* --------------------------------- DEF-03 --------------------------------- */

test('DEF-03 网络 Internal=false 必须拒绝执行', async () => {
  const iso = await loadIsolation('internal_false', 'a');
  const st = await iso.isolationStatus();
  assert.equal(st.available, false, 'Internal=false 不得视为可用');
  assert.equal(st.networkInternal, false);
  assert.match(st.reason, /Internal=false/);
});

test('DEF-03 网络不存在必须拒绝执行', async () => {
  const iso = await loadIsolation('no_network', 'b');
  const st = await iso.isolationStatus();
  assert.equal(st.available, false);
  assert.match(st.reason, /不存在/);
});

test('DEF-03 正常内部网络可用', async () => {
  const iso = await loadIsolation('ok', 'c');
  const st = await iso.isolationStatus();
  assert.equal(st.available, true);
  assert.equal(st.networkInternal, true);
});

/* --------------------------------- DEF-01 --------------------------------- */

test('DEF-01 daemon 失联不得报告取消完成', async () => {
  const iso = await loadIsolation('daemon_down', 'd');
  const r = await iso.killContainer('jarvis-exec-x');
  assert.equal(r.confirmed, false);
  assert.equal(r.reason, 'docker_daemon_unreachable');
});

test('DEF-01 容器不存在且 daemon 正常 → 确认已停止', async () => {
  const iso = await loadIsolation('ok', 'e');
  const r = await iso.killContainer('jarvis-exec-x');
  assert.equal(r.confirmed, true);
  assert.equal(r.state, 'gone');
});

test('DEF-01 容器仍在运行不得报告已停止', async () => {
  const iso = await loadIsolation('stuck', 'f');
  const r = await iso.killContainer('jarvis-exec-x');
  assert.equal(r.confirmed, false);
  assert.equal(r.reason, 'container_still_running');
});

/* --------------------------------- DEF-02 --------------------------------- */

test('DEF-02 取消同时覆盖执行容器与验证容器', async () => {
  const iso = await loadIsolation('ok', 'g');
  const svc = await import('../src/service.mjs?' + 'g');
  const uniq = `f2d-cancel-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const p = svc.createProject({ name: '取消覆盖', slug: uniq });
  const t = svc.createTask({ project: p.id, title: '取消', input: 'x' });
  // 造一个可取消的 execution
  const execId = `exe_fake_${Date.now().toString(36)}`;
  svc.db()
    .prepare("INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)")
    .run(execId, t.id, null, 'running', 'claude-code', '', new Date().toISOString());
  svc.updateTask(t.id, { status: 'running' });

  writeFileSync(callLog, '');
  const r = await svc.cancelTask(t.id);
  const calls = readFileSync(callLog, 'utf8');
  assert.match(calls, new RegExp(`kill jarvis-exec-${execId}`));
  assert.match(calls, new RegExp(`kill jarvis-verify-${execId}`));
  assert.equal(r.ok, true);
});
