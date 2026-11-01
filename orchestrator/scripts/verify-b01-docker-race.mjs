#!/usr/bin/env node
/**
 * B01 真实 Docker 启动/取消竞态。
 *
 * 用一个 wrapper 在真实 `docker run` 之前建立文件屏障，确保：
 *   启动意图/started 已登记 → docker run 尚未执行 → 取消 → 释放屏障 → 真实容器启动。
 * 修复后取消必须等待并实际终止容器；不得在屏障释放前返回 ok=true。
 *
 * 需要本机 Docker + 测试镜像 jarvis-b01-exec:test（alpine + sleep 120）。
 * 不消耗模型额度。
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REAL_HOME = homedir();
const HOME_DIR = '/tmp/jarvis-b01-docker/home';
const DOCKER = process.env.JARVIS_DOCKER_BIN_REAL || '/Applications/Docker.app/Contents/Resources/bin/docker';
const IMAGE = process.env.JARVIS_B01_IMAGE || 'jarvis-b01-exec:test';
const ENTERED = '/tmp/jarvis-b01-docker/run-entered';
const RELEASE = '/tmp/jarvis-b01-docker/run-release';
const WRAPPER = '/tmp/jarvis-b01-docker/docker-wrapper.sh';

rmSync('/tmp/jarvis-b01-docker', { recursive: true, force: true });
mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });
mkdirSync(join(HOME_DIR, 'jarvis'), { recursive: true });
writeFileSync(join(HOME_DIR, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'test' } }));

writeFileSync(WRAPPER, `#!/bin/sh
if [ "$1" = "run" ]; then
  : > "${ENTERED}"
  i=0
  while [ ! -f "${RELEASE}" ]; do
    i=$((i+1))
    [ "$i" -gt 1200 ] && exit 124
    sleep 0.05
  done
fi
exec "${DOCKER}" "$@"
`);
chmodSync(WRAPPER, 0o755);

process.env.DOCKER_HOST = process.env.DOCKER_HOST || `unix://${join(REAL_HOME, '.docker/run/docker.sock')}`;
process.env.HOME = HOME_DIR;
process.env.JARVIS_HOME = join(HOME_DIR, 'jarvis');
process.env.JARVIS_DB = join(HOME_DIR, 'jarvis', 'state.db');
process.env.JARVIS_DOCKER_BIN = WRAPPER;
process.env.JARVIS_EXECUTOR_IMAGE = IMAGE;
process.env.JARVIS_EXECUTOR_NETWORK = 'jarvis-internal';

const svc = await import('../src/service.mjs');
const ex = await import('../src/executor.mjs');

const gitRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return g('rev-parse', 'HEAD').trim();
};

const waitForFile = async (path, label, failCheck = () => null) => {
  for (let i = 0; i < 600; i++) {
    const failure = failCheck();
    if (failure) throw failure;
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const failure = failCheck();
  throw failure || new Error(`${label} timeout`);
};

const p = svc.createProject({ name: 'B01 Docker Race', slug: `b01-docker-${Date.now().toString(36)}` });
const repo = join(p.dir, 'repo');
const head = gitRepo(repo);
const task = svc.createTask({
  project: p.id,
  title: 'B01 docker race',
  input: 'noop',
  kind: 'executor',
  executor: 'claude-code',
  executorConfig: { mode: 'plan', repo: 'repo', base_commit: head }
});

let cancelResolvedBeforeRelease = false;
let releaseWritten = false;
let cancel = null;
let result = null;
try {
  let runFailure = null;
  const running = svc.runTask(task.id);
  running.catch((e) => { runFailure = e; });
  await waitForFile(ENTERED, 'docker-run-entered', () => runFailure);

  const cancelling = svc.cancelTask(task.id);
  cancelling.then((r) => { cancel = r; cancelResolvedBeforeRelease = !releaseWritten; });
  for (let i = 0; i < 500; i++) {
    if (['cancel_requested', 'cancelled'].includes(svc.getTask(task.id).status)) break;
    await new Promise((r) => setImmediate(r));
  }
  assertStatus('cancel_requested or cancelled', ['cancel_requested', 'cancelled']);
  // 此刻真实 docker run 仍被 wrapper 挡住；取消不得已返回 ok=true。
  await new Promise((r) => setImmediate(r));
  if (cancelResolvedBeforeRelease) {
    throw new Error('cancel reported complete before the delayed docker run was released');
  }

  releaseWritten = true;
  writeFileSync(RELEASE, 'go');
  cancel = await cancelling;
  result = await running;
} finally {
  try { releaseWritten = true; writeFileSync(RELEASE, 'go'); } catch {}
}

function assertStatus(_label, allowed) {
  const s = svc.getTask(task.id).status;
  if (!allowed.includes(s)) throw new Error(`task status ${s}`);
}

const resource = svc.db().prepare('SELECT * FROM execution_resources WHERE task_id=?').get(task.id);
const execution = svc.db().prepare('SELECT * FROM executions WHERE task_id=? ORDER BY started_at DESC').get(task.id);
const ps = execFileSync(DOCKER, ['ps', '-a', '--filter', `name=jarvis-exec-${result?.execution}`, '--format', '{{.Names}} {{.Status}}'], {
  encoding: 'utf8',
  env: { ...process.env, HOME: REAL_HOME, DOCKER_HOST: process.env.DOCKER_HOST }
}).trim();

const evidence = {
  task: task.id,
  taskStatus: svc.getTask(task.id).status,
  cancelOk: cancel?.ok ?? null,
  cancelResolvedBeforeRelease,
  executionStatus: execution?.status ?? null,
  resourceState: resource?.state ?? null,
  resourceStoppedAt: resource?.stopped_at ?? null,
  resultBlocked: result?.blocked ?? null,
  containerPs: ps,
  image: IMAGE
};
console.log(JSON.stringify(evidence, null, 2));

if (
  cancelResolvedBeforeRelease ||
  !cancel?.ok ||
  svc.getTask(task.id).status !== 'cancelled' ||
  execution?.status !== 'cancelled' ||
  !['stopped', 'abandoned'].includes(resource?.state) ||
  ps.length > 0
) {
  process.exit(1);
}
