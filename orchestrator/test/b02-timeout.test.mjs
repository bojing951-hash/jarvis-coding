/**
 * B02-QA-01..05: 子进程错误语义、Claude/Verify/Audit 结果完整性、
 * TERM/KILL 证明、daemon 失联、资源终态。
 *
 * 使用真实 production sh()/runClaudeIsolated()/runInWorkdir()/killContainer()
 * 与真实 execFile；Docker 本身用受控 fake CLI 注入异常，不依赖模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-b02-'));
process.env.HOME = tmp;
process.env.JARVIS_HOME = join(tmp, 'jarvis');
process.env.JARVIS_DB = join(tmp, 'state.db');
process.env.JARVIS_EXECUTOR_IMAGE = 'fake-image:1';
process.env.JARVIS_EXECUTOR_NETWORK = 'fake-net';
mkdirSync(join(tmp, '.claude'), { recursive: true });
writeFileSync(join(tmp, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'test' } }));

const fakeDocker = join(tmp, 'docker-fake.sh');
writeFileSync(fakeDocker, `#!/bin/sh
mode="\${FAKE_DOCKER_MODE:-ok}"
case "$1" in
  info)
    [ "$mode" = "info_signal" ] && kill -TERM $$
    [ "$mode" = "info_timeout" ] && sleep 5
    echo "29.9.2"; exit 0 ;;
  image)
    echo "sha256:fake"; exit 0 ;;
  network)
    echo "true"; exit 0 ;;
  run)
    case "$*" in
      *--entrypoint*)
        [ "$mode" = "verify_signal" ] && kill -TERM $$
        [ "$mode" = "verify_timeout" ] && sleep 5
        [ "$mode" = "verify_nonzero" ] && exit 7
        exit 0 ;;
      *)
        [ "$mode" = "run_signal" ] && kill -TERM $$
        [ "$mode" = "run_timeout" ] && sleep 5
        [ "$mode" = "run_nonzero" ] && exit 7
        exit 0 ;;
    esac ;;
  kill)
    [ "$mode" = "kill_timeout" ] && sleep 5
    { [ "$mode" = "kill_signal" ] || [ "$mode" = "inspect_exited" ]; } && kill -TERM $$
    exit 0 ;;
  inspect)
    case "$*" in
      *jarvis-proxy*) echo '{"fake-net":{"IPAddress":"172.18.0.99"}}'; exit 0 ;;
      *)
        [ "$mode" = "inspect_timeout" ] && sleep 5
        [ "$mode" = "inspect_exited" ] && { echo "exited"; exit 0; }
        echo "Error: No such object: x"; exit 1 ;;
    esac ;;
  *)
    exit 0 ;;
esac
`);
chmodSync(fakeDocker, 0o755);
process.env.JARVIS_DOCKER_BIN = fakeDocker;

const iso = await import('../src/isolation.mjs');
const svc = await import('../src/service.mjs');

const gitRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return g('rev-parse', 'HEAD').trim();
};

function projectRepo(label) {
  const p = svc.createProject({ name: label, slug: `${label}-${Date.now().toString(36)}` });
  const repo = join(p.dir, 'repo');
  const head = gitRepo(repo);
  return { p, repo, head };
}

function seedProfile(project) {
  const id = `vpr_${Date.now().toString(36)}`;
  svc.db()
    .prepare('INSERT INTO verify_profiles (id,project_id,name,program,argv,cwd,timeout_ms,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, project.id, 'ok', process.execPath, '[]', null, 300_000, 'b02', new Date().toISOString());
  return id;
}

/* ------------------------------- QA-01 --------------------------------- */

test('B02-QA-01 真实 execFile 超时不得返回成功', async () => {
  process.env.FAKE_DOCKER_MODE = 'run_timeout';
  const r = await iso.runClaudeIsolated({
    workdir: tmp,
    prompt: 'x',
    image: 'fake-image:1',
    name: 'b02-timeout',
    network: 'fake-net',
    timeoutMs: 100
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.exitCode, null);
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, true);
});

test('B02-QA-01 真实 execFile 信号终止不得返回成功', async () => {
  process.env.FAKE_DOCKER_MODE = 'run_signal';
  const r = await iso.runClaudeIsolated({
    workdir: tmp,
    prompt: 'x',
    image: 'fake-image:1',
    name: 'b02-signal',
    network: 'fake-net',
    timeoutMs: 5000
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.exitCode, null);
  assert.equal(r.signal, 'SIGTERM');
});

test('B02-QA-01 正常退出 0 仍是成功', async () => {
  process.env.FAKE_DOCKER_MODE = 'ok';
  const r = await iso.runClaudeIsolated({
    workdir: tmp,
    prompt: 'x',
    image: 'fake-image:1',
    name: 'b02-ok',
    network: 'fake-net',
    timeoutMs: 5000
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.exitCode, 0);
});

test('B02-QA-01 sh 正常非零退出保留真实退出码', async () => {
  const r = await iso.sh('/bin/sh', ['-c', 'exit 7']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 7);
  assert.equal(r.abnormal, false);
});

test('B02-QA-01 sh 外部信号不得映射为成功', async () => {
  const r = await iso.sh('/bin/sh', ['-c', 'kill -TERM $$']);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(r.timedOut, false);
  assert.equal(r.abnormal, true);
});

test('B02-QA-01 sh 不存在的可执行文件不得成功', async () => {
  const r = await iso.sh('/definitely/not/a/real/binary', ['--version']);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.equal(r.errorCode, 'ENOENT');
  assert.equal(r.abnormal, true);
});

test('B02-QA-01 sh 超过 maxBuffer 不得成功', async () => {
  const r = await iso.sh('/bin/sh', ['-c', 'yes x'], { maxBuffer: 1024, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.equal(r.abnormal, true);
  assert.match(String(r.errorCode ?? r.error), /maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER|maxBuffer/i);
});

/* ------------------------------- QA-02 --------------------------------- */

test('B02-QA-02 Claude CLI 信号不得让 Task 变成 done', async () => {
  const { p, head } = projectRepo('b02claude');
  const t = svc.createTask({
    project: p.id,
    title: 'claude timeout',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'plan', repo: 'repo', base_commit: head }
  });
  process.env.FAKE_DOCKER_MODE = 'run_signal';
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false, JSON.stringify({ blocked: r.blocked, task: svc.getTask(t.id).status }));
  assert.notEqual(svc.getTask(t.id).status, 'done');
});

test('B02-QA-02 Verify 容器信号不得被当成通过', async () => {
  const { p, head } = projectRepo('b02verify');
  const vp = seedProfile(p);
  const t = svc.createTask({
    project: p.id,
    title: 'verify timeout',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'plan', repo: 'repo', base_commit: head, verify_profile_id: vp }
  });
  process.env.FAKE_DOCKER_MODE = 'verify_signal';
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false, JSON.stringify({ blocked: r.blocked, verify: r.verify, task: svc.getTask(t.id).status }));
  assert.notEqual(svc.getTask(t.id).status, 'done');
});

test('B02-QA-02 Audit 容器信号不得被当成成功审计', async () => {
  const { p, head } = projectRepo('b02audit');
  const t = svc.createTask({
    project: p.id,
    title: 'audit timeout',
    input: 'x',
    kind: 'audit',
    executor: 'claude-code',
    executorConfig: { repo: 'repo', commit: head, contract: '# contract' }
  });
  process.env.FAKE_DOCKER_MODE = 'run_signal';
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false, JSON.stringify({ blocked: r.blocked, task: svc.getTask(t.id).status }));
  assert.notEqual(svc.getTask(t.id).status, 'done');
});

/* ------------------------------- QA-03 --------------------------------- */

test('B02-QA-03 信号终止的 docker kill 不得产生 killAccepted/confirmed', async () => {
  process.env.FAKE_DOCKER_MODE = 'kill_signal';
  const r = await iso.killContainer('b02-kill-signal');
  assert.equal(r.killAccepted, false, JSON.stringify(r));
  assert.equal(r.confirmed, false, '不可信的 gone 不得确认停止');
});

/* ------------------------------- QA-04 --------------------------------- */

test('B02-QA-04 docker info 被信号终止时 daemon 不得被判健康', async () => {
  process.env.FAKE_DOCKER_MODE = 'info_signal';
  const ok = await iso.daemonReachable();
  assert.equal(ok, false);
});

test('B02-QA-04 docker info 超时不得被判健康', async () => {
  process.env.FAKE_DOCKER_MODE = 'info_timeout';
  const ok = await iso.daemonReachable({ timeoutMs: 100 });
  assert.equal(ok, false);
});

test('B02-QA-03 独立可信 exited 证据可在 kill 不可信时确认停止', async () => {
  process.env.FAKE_DOCKER_MODE = 'inspect_exited';
  const r = await iso.killContainer('b02-exited');
  assert.equal(r.killAccepted, false, JSON.stringify(r));
  assert.equal(r.confirmed, true, 'exited 是独立可信停止证据');
  assert.equal(r.state, 'exited');
});

/* ------------------------------- QA-05 --------------------------------- */

test('B02-QA-05 launchContainer 超时结果不得写 stopped', async () => {
  const { p, head } = projectRepo('b02resource');
  const t = svc.createTask({
    project: p.id,
    title: 'resource timeout',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'plan', repo: 'repo', base_commit: head }
  });
  const fakeIsolation = {
    isolationStatus: async () => ({ available: true, backend: 'fake', image: 'fake', network: 'fake', networkInternal: true }),
    egressProxyUrl: async () => 'http://127.0.0.1:9',
    runClaudeIsolated: async () => ({ ok: false, exitCode: null, timedOut: true, killed: true, signal: 'SIGTERM', text: '', raw: '' }),
    runInWorkdir: async () => ({ ok: false, exitCode: null, timedOut: true, killed: true, signal: 'SIGTERM', output: '' })
  };
  const r = await svc.runTask(t.id, { isolation: fakeIsolation });
  assert.equal(r.ok, false);
  const resource = svc.listResources(t.id)[0];
  assert.equal(resource?.state, 'unknown', JSON.stringify(resource));
  assert.notEqual(svc.getTask(t.id).status, 'done');
});


test('B02-QA-04 无 resources 的历史执行取消不得绕过终止证明', async () => {
  const { p } = projectRepo('b02legacy');
  const t = svc.createTask({ project: p.id, title: 'legacy cancel', input: 'x' });
  svc.updateTask(t.id, { status: 'running' });
  const execId = `exe_b02legacy_${Date.now().toString(36)}`;
  svc.db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, t.id, null, 'running', 'test', '', new Date().toISOString());
  process.env.FAKE_DOCKER_MODE = 'kill_signal';
  const r = await svc.cancelTask(t.id);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(svc.getTask(t.id).status, 'cancel_requested');
});


test('B02-QA-05 正常非零容器退出：任务失败但资源可确认 stopped', async () => {
  const { p, head } = projectRepo('b02nonzero');
  const t = svc.createTask({
    project: p.id,
    title: 'nonzero',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'plan', repo: 'repo', base_commit: head }
  });
  const fakeIsolation = {
    isolationStatus: async () => ({ available: true, backend: 'fake', image: 'fake', network: 'fake', networkInternal: true }),
    egressProxyUrl: async () => 'http://127.0.0.1:9',
    runClaudeIsolated: async () => ({ ok: false, exitCode: 1, abnormal: false, timedOut: false, signal: null, killed: false, text: 'nonzero', raw: '' }),
    runInWorkdir: async () => ({ ok: false, exitCode: 1, abnormal: false, output: '' })
  };
  const r = await svc.runTask(t.id, { isolation: fakeIsolation });
  assert.equal(r.ok, false);
  assert.equal(svc.getTask(t.id).status, 'failed');
  assert.equal(svc.listResources(t.id)[0]?.state, 'stopped');
});

test('B02-QA-05 执行适配层抛异常：资源必须 unknown，不得伪造 stopped', async () => {
  const { p, head } = projectRepo('b02throw');
  const t = svc.createTask({
    project: p.id,
    title: 'throw',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'plan', repo: 'repo', base_commit: head }
  });
  const fakeIsolation = {
    isolationStatus: async () => ({ available: true, backend: 'fake', image: 'fake', network: 'fake', networkInternal: true }),
    egressProxyUrl: async () => 'http://127.0.0.1:9',
    runClaudeIsolated: async () => { throw new Error('simulated adapter crash'); },
    runInWorkdir: async () => ({ ok: false, exitCode: null, abnormal: true, output: '' })
  };
  await assert.rejects(() => svc.runTask(t.id, { isolation: fakeIsolation }), /simulated adapter crash/);
  assert.equal(svc.listResources(t.id)[0]?.state, 'unknown');
});


test('B02-QA-03 Docker kill 超时不得产生 killAccepted 或 confirmed', async () => {
  process.env.FAKE_DOCKER_MODE = 'kill_timeout';
  const r = await iso.killContainer('b02-kill-timeout', { graceMs: 100, killTimeoutMs: 100 });
  assert.equal(r.killAccepted, false, JSON.stringify(r));
  assert.equal(r.confirmed, false, '超时 kill + gone 不得确认停止');
});


test('B02-QA-01 Verify workdir CLI 超时不得返回成功', async () => {
  process.env.FAKE_DOCKER_MODE = 'verify_timeout';
  const r = await iso.runInWorkdir({
    workdir: tmp,
    program: 'node',
    args: [],
    image: 'fake-image:1',
    name: 'b02-verify-timeout',
    network: 'fake-net',
    timeoutMs: 100
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.exitCode, null);
  assert.equal(r.timedOut, true);
  assert.equal(r.abnormal, true);
});


test('B02-QA-04 Docker inspect 超时不得产生 confirmed', async () => {
  process.env.FAKE_DOCKER_MODE = 'inspect_timeout';
  const r = await iso.killContainer('b02-inspect-timeout', {
    graceMs: 100,
    killTimeoutMs: 100,
    inspectTimeoutMs: 50
  });
  assert.equal(r.confirmed, false, JSON.stringify(r));
});
