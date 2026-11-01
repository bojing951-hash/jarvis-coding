#!/usr/bin/env node
/**
 * B02-QA-06 / A4-04：真实 Docker 启动/取消竞态与残留证明。
 *
 * - 唯一隔离临时目录，不清理非本测试文件/容器/网络
 * - Execution ID 与容器名从真实 SQLite 读取，不用 result.execution 作为唯一来源
 * - 记录 container ID、inspect 状态序列、正确名称的 docker ps -a、Git HEAD
 * - 屏障在 claimDockerInvocation 之后、真实 docker run 之前
 *
 * 需要本机 Docker + 测试镜像 jarvis-b01-exec:test（alpine + sleep 120）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { evaluateDockerRaceEvidence, isTrustedGoneInspect } from './b03-docker-evidence.mjs';

const REAL_HOME = homedir();
const ROOT = mkdtempSync(join(tmpdir(), 'jarvis-b02-docker-'));
const HOME_DIR = join(ROOT, 'home');
const DOCKER = process.env.JARVIS_DOCKER_BIN_REAL || '/Applications/Docker.app/Contents/Resources/bin/docker';
const IMAGE = process.env.JARVIS_B02_IMAGE || 'jarvis-b01-exec:test';
const ENTERED = join(ROOT, 'run-entered');
const RELEASE = join(ROOT, 'run-release');
const WRAPPER = join(ROOT, 'docker-wrapper.sh');
const LOGS = join(ROOT, 'logs');

mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });
mkdirSync(join(HOME_DIR, 'jarvis'), { recursive: true });
mkdirSync(LOGS, { recursive: true });
writeFileSync(join(HOME_DIR, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'test' } }));

const dockerEnv = { ...process.env, HOME: REAL_HOME };
if (!process.env.DOCKER_HOST && existsSync(join(REAL_HOME, '.docker/run/docker.sock'))) {
  process.env.DOCKER_HOST = `unix://${join(REAL_HOME, '.docker/run/docker.sock')}`;
  dockerEnv.DOCKER_HOST = process.env.DOCKER_HOST;
}

try {
  execFileSync(DOCKER, ['image', 'inspect', IMAGE], { stdio: 'ignore', env: dockerEnv, timeout: 20_000 });
} catch {
  console.error(`missing test image: ${IMAGE}`);
  console.error('build: docker build -t ' + IMAGE + ' /tmp/jarvis-b01-image');
  process.exit(2);
}

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

process.env.HOME = HOME_DIR;
process.env.JARVIS_HOME = join(HOME_DIR, 'jarvis');
process.env.JARVIS_DB = join(HOME_DIR, 'jarvis', 'state.db');
process.env.JARVIS_DOCKER_BIN = WRAPPER;
process.env.JARVIS_EXECUTOR_IMAGE = IMAGE;
process.env.JARVIS_EXECUTOR_NETWORK = 'jarvis-internal';

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
const gitHead = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const docker = (args) => execFileSync(DOCKER, args, { encoding: 'utf8', env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

const project = svc.createProject({ name: 'B02 Docker Race', slug: `b02-docker-${Date.now().toString(36)}` });
const repo = join(project.dir, 'repo');
const base = gitRepo(repo);
const headBefore = gitHead(repo);
const task = svc.createTask({
  project: project.id,
  title: 'B02 docker race',
  input: 'noop',
  kind: 'executor',
  executor: 'claude-code',
  executorConfig: { mode: 'plan', repo: 'repo', base_commit: base }
});

let containerName = null;
let containerId = null;
let executionId = null;
let executionRow = null;
let resourceRow = null;
let cancel = null;
let result = null;
let runFailure = null;
let cancelResolvedBeforeRelease = false;
let releaseWritten = false;
let sawContainerRunning = false;
const observedStates = [];
const startedAt = Date.now();
let releaseAt = null;

const cleanup = () => {
  if (!containerName) return;
  try {
    execFileSync(DOCKER, ['rm', '-f', containerName], { stdio: 'ignore', env: dockerEnv, timeout: 30_000 });
  } catch {}
};
process.on('exit', cleanup);

try {
  const running = svc.runTask(task.id);
  running.catch((e) => { runFailure = e; });
  await waitForFile(ENTERED, 'docker-run-entered', () => runFailure);

  // 以真实 SQLite 为准：Execution ID、容器名、资源行。
  executionRow = svc.db().prepare("SELECT * FROM executions WHERE task_id=? AND status='running' ORDER BY started_at DESC").get(task.id);
  if (!executionRow) throw new Error('no running execution row at docker barrier');
  executionId = executionRow.id;
  resourceRow = svc.db().prepare("SELECT * FROM execution_resources WHERE execution_id=? AND kind='claude' ORDER BY started_at DESC").get(executionId);
  if (!resourceRow) throw new Error(`no claude resource row for execution ${executionId}`);
  containerName = `jarvis-exec-${executionId}`;
  if (resourceRow.name !== containerName) {
    throw new Error(`resource name mismatch: ${resourceRow.name} != ${containerName}`);
  }

  const cancelling = svc.cancelTask(task.id);
  cancelling.then((r) => { cancel = r; cancelResolvedBeforeRelease = !releaseWritten; });
  for (let i = 0; i < 1000; i++) {
    if (['cancel_requested', 'cancelled'].includes(svc.getTask(task.id).status)) break;
    await new Promise((r) => setImmediate(r));
  }
  if (!['cancel_requested', 'cancelled'].includes(svc.getTask(task.id).status)) {
    throw new Error(`task not marked cancel_requested: ${svc.getTask(task.id).status}`);
  }
  // 真实 docker run 仍被屏障挡住：取消不得已返回成功。
  await new Promise((r) => setImmediate(r));
  if (cancelResolvedBeforeRelease) {
    throw new Error('cancel reported complete before the delayed docker run was released');
  }

  const pollContainer = (async () => {
    for (let i = 0; i < 800; i++) {
      try {
        const status = docker(['inspect', containerName, '--format', '{{.State.Status}}']);
        if (status && !observedStates.includes(status)) observedStates.push(status);
        if (['created', 'running'].includes(status)) sawContainerRunning = true;
        const id = docker(['inspect', containerName, '--format', '{{.Id}}']);
        if (id) containerId = id;
      } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
  })();

  releaseWritten = true;
  releaseAt = Date.now();
  writeFileSync(RELEASE, 'go');
  cancel = await cancelling;
  result = await running;
  await pollContainer;
} finally {
  if (!releaseWritten) {
    releaseWritten = true;
    releaseAt = Date.now();
    try { writeFileSync(RELEASE, 'go'); } catch {}
  }
}

const executionAfter = svc.db().prepare('SELECT * FROM executions WHERE id=?').get(executionId);
const resourceAfter = svc.db().prepare('SELECT * FROM execution_resources WHERE id=?').get(resourceRow?.id);
const taskAfter = svc.getTask(task.id);
const headAfter = gitHead(repo);
let ps = null;
let inspectAfter = null;
let events = [];
let eventsOk = false;
let eventsError = null;
if (containerName) {
  const psRun = spawnSync(DOCKER, ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}} {{.Status}}'], {
    encoding: 'utf8',
    env: dockerEnv,
    timeout: 10_000
  });
  ps = {
    ok: psRun.status === 0,
    status: psRun.status,
    stdout: psRun.stdout || '',
    stderr: psRun.stderr || '',
    error: psRun.error?.message ?? null,
    signal: psRun.signal ?? null
  };

  const inspectRun = spawnSync(DOCKER, ['inspect', containerName, '--format', '{{.State.Status}}'], {
    encoding: 'utf8',
    env: dockerEnv,
    timeout: 5_000
  });
  inspectAfter = {
    ok: inspectRun.status === 0,
    status: inspectRun.status,
    stdout: inspectRun.stdout || '',
    stderr: inspectRun.stderr || '',
    error: inspectRun.error?.message ?? null,
    signal: inspectRun.signal ?? null,
    abnormal: Boolean(inspectRun.error || inspectRun.signal || inspectRun.status === null)
  };
  inspectAfter.trustedGone = isTrustedGoneInspect(inspectAfter, containerName);

  const eventsRun = spawnSync(
    DOCKER,
    [
      'events',
      '--since', String(Math.floor(startedAt / 1000) - 1),
      '--until', String(Math.floor(Date.now() / 1000)),
      '--filter', `container=${containerName}`,
      '--format', '{{.Action}}'
    ],
    { encoding: 'utf8', env: dockerEnv, timeout: 15_000 }
  );
  eventsOk = eventsRun.status === 0;
  eventsError = eventsRun.error?.message ?? (eventsRun.stderr || '').trim() ?? null;
  const actions = (eventsRun.stdout || '')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => ['create', 'start', 'die', 'destroy'].includes(x));
  events = [...new Set(actions)];
}

const evidence = {
  testRoot: ROOT,
  startedAt,
  releaseAt,
  task: task.id,
  executionId,
  executionIdSource: 'sqlite executions.status=running at docker barrier',
  executionStatus: executionAfter?.status ?? null,
  resourceId: resourceRow?.id ?? null,
  resourceName: resourceRow?.name ?? null,
  resourceState: resourceAfter?.state ?? null,
  resourceStoppedAt: resourceAfter?.stopped_at ?? null,
  containerName,
  containerId,
  containerNameMatchesExecution: containerName === `jarvis-exec-${executionId}`,
  sawContainerRunning,
  observedStates,
  inspectAfter,
  cancelOk: cancel?.ok ?? null,
  cancelResolvedBeforeRelease,
  taskStatus: taskAfter.status,
  resultBlocked: result?.blocked ?? null,
  ps,
  containerPs: ps?.stdout ?? '',
  events,
  eventsOk,
  eventsError,
  gitHeadBefore: headBefore,
  gitHeadAfter: headAfter,
  image: IMAGE
};

const validation = evaluateDockerRaceEvidence(evidence);
console.log(JSON.stringify({ ...evidence, validation }, null, 2));

if (!validation.ok) {
  cleanup();
  process.exit(1);
}
