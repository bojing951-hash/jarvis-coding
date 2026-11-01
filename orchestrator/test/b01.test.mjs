/**
 * B01 复现：取消已确认后仍可能启动执行/验证容器。
 *
 * 使用确定性启动屏障（不是 sleep）：容器启动协程在真正“启动”前挂起，
 * 取消先完成，再释放启动协程，观察迟到的启动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installTestAuthKey } from './helpers/auth.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-b01-'));
process.env.HOME = tmp;
process.env.JARVIS_HOME = join(tmp, 'jarvis');
process.env.JARVIS_DB = join(tmp, 'state.db');
mkdirSync(join(tmp, '.claude'), { recursive: true });
writeFileSync(join(tmp, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'test' } }));
const auth = installTestAuthKey(tmp);

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

function makeTask(label) {
  const p = svc.createProject({ name: label, slug: `${label}-${Date.now().toString(36)}` });
  const repo = join(p.dir, 'repo');
  const head = gitRepo(repo);
  const vp = `vpr_${label}_${Date.now().toString(36)}`;
  svc.db()
    .prepare('INSERT INTO verify_profiles (id,project_id,name,program,argv,cwd,timeout_ms,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(vp, p.id, 'ok', process.execPath, '[]', null, 300_000, 'b01', new Date().toISOString());
  const t = svc.createTask({
    project: p.id,
    title: label,
    input: 'write feature.txt',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: {
      mode: 'acceptEdits',
      repo: 'repo',
      base_commit: head,
      commit: true,
      commit_paths: ['feature.txt'],
      verify_profile_id: vp
    }
  });
  const challenge = svc.createAuthChallenge(t.id);
  const issued = svc.issueApproval({ task: t.id, proof: auth.proofFor(challenge) });
  assert.equal(issued.ok, true, issued.error);
  return { t, repo };
}

async function waitForTaskStatus(taskId, allowed, label) {
  for (let i = 0; i < 300; i++) {
    const status = svc.getTask(taskId).status;
    if (allowed.includes(status)) return status;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`${label}: task status timeout, last=${svc.getTask(taskId).status}`);
}

function claudeBarrier() {
  let markStarted;
  let release;
  const started = new Promise((r) => { markStarted = r; });
  const hold = new Promise((r) => { release = r; });
  let launched = false;
  let stopped = false;
  const iso = {
    isolationStatus: async () => ({ available: true, backend: 'fake', image: 'fake', network: 'fake', networkInternal: true }),
    egressProxyUrl: async () => 'http://127.0.0.1:9',
    runClaudeIsolated: async ({ workdir, guard }) => {
      markStarted();
      await hold;
      if (guard && !(await guard())) {
        return { ok: false, cancelled: true, blocked: 'cancelled', exitCode: null, text: '', raw: 'guard_cancelled' };
      }
      launched = true;
      writeFileSync(join(workdir, 'feature.txt'), 'late claude start\n');
      return { ok: true, exitCode: 0, text: 'late', isolated: true, network: 'fake', image: 'fake', raw: '' };
    },
    runInWorkdir: async () => ({ ok: true, exitCode: 0, output: 'verify ok' }),
    killContainer: async () => {
      if (!launched) return { ok: true, confirmed: true, state: 'gone' };
      stopped = true;
      return { ok: true, confirmed: true, state: 'exited' };
    }
  };
  return {
    iso,
    started,
    release: () => release(),
    alive: () => launched && !stopped
  };
}

function verifyBarrier() {
  let markStarted;
  let release;
  const started = new Promise((r) => { markStarted = r; });
  const hold = new Promise((r) => { release = r; });
  let launched = false;
  let stopped = false;
  const iso = {
    isolationStatus: async () => ({ available: true, backend: 'fake', image: 'fake', network: 'fake', networkInternal: true }),
    egressProxyUrl: async () => 'http://127.0.0.1:9',
    runClaudeIsolated: async ({ workdir }) => {
      writeFileSync(join(workdir, 'feature.txt'), 'claude done\n');
      return { ok: true, exitCode: 0, text: 'done', isolated: true, network: 'fake', image: 'fake', raw: '' };
    },
    runInWorkdir: async ({ guard }) => {
      markStarted();
      await hold;
      if (guard && !(await guard())) {
        return { ok: false, cancelled: true, blocked: 'cancelled', exitCode: null, output: 'guard_cancelled' };
      }
      launched = true;
      return { ok: true, exitCode: 0, output: 'late verify start' };
    },
    killContainer: async () => {
      if (!launched) return { ok: true, confirmed: true, state: 'gone' };
      stopped = true;
      return { ok: true, confirmed: true, state: 'exited' };
    }
  };
  return {
    iso,
    started,
    release: () => release(),
    alive: () => launched && !stopped
  };
}

test('B01-A 执行容器：取消已报告成功后不得迟到启动', async () => {
  const { t } = makeTask('b01a');
  const barrier = claudeBarrier();
  const running = svc.runTask(t.id, { isolation: barrier.iso });
  await barrier.started;

  const cancelling = svc.cancelTask(t.id, { isolation: barrier.iso });
  await waitForTaskStatus(t.id, ['cancel_requested', 'cancelled'], 'B01-A');
  barrier.release();
  const cancel = await cancelling;
  const result = await running;

  assert.equal(
    Boolean(cancel.ok) && barrier.alive(),
    false,
    `取消返回 ok=${cancel.ok} 后仍观察到迟到启动 (task=${svc.getTask(t.id).status}, result=${result.blocked})`
  );
  const resources = svc.listResources(t.id);
  assert.ok(resources.length > 0);
  assert.ok(resources.every((r) => ['abandoned', 'stopped'].includes(r.state)), JSON.stringify(resources));
  assert.equal(svc.getTask(t.id).status, 'cancelled');
  const execution = svc.db().prepare('SELECT * FROM executions WHERE task_id=?').get(t.id);
  assert.equal(execution.status, 'cancelled');
  const repeat = await svc.cancelTask(t.id, { isolation: barrier.iso });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.already_cancelled, true);
});

test('B01-B 验证容器：取消已报告成功后不得迟到启动', async () => {
  const { t } = makeTask('b01b');
  const barrier = verifyBarrier();
  const running = svc.runTask(t.id, { isolation: barrier.iso });
  await barrier.started;

  const cancelling = svc.cancelTask(t.id, { isolation: barrier.iso });
  await waitForTaskStatus(t.id, ['cancel_requested', 'cancelled'], 'B01-B');
  barrier.release();
  const cancel = await cancelling;
  const result = await running;

  assert.equal(
    Boolean(cancel.ok) && barrier.alive(),
    false,
    `取消返回 ok=${cancel.ok} 后仍观察到验证容器迟到启动 (task=${svc.getTask(t.id).status}, result=${result.blocked})`
  );
  const resources = svc.listResources(t.id);
  assert.ok(resources.some((r) => r.kind === 'claude' && ['stopped', 'abandoned'].includes(r.state)), JSON.stringify(resources));
  assert.ok(resources.some((r) => r.kind === 'verify' && r.state === 'abandoned'), JSON.stringify(resources));
  assert.equal(svc.getTask(t.id).status, 'cancelled');
});


function auditBarrier() {
  let markStarted;
  let release;
  const started = new Promise((r) => { markStarted = r; });
  const hold = new Promise((r) => { release = r; });
  let launched = false;
  let stopped = false;
  const iso = {
    isolationStatus: async () => ({ available: true, backend: 'fake', image: 'fake', network: 'fake', networkInternal: true }),
    egressProxyUrl: async () => 'http://127.0.0.1:9',
    runClaudeIsolated: async ({ guard }) => {
      markStarted();
      await hold;
      if (guard && !(await guard())) {
        return { ok: false, cancelled: true, blocked: 'cancelled', exitCode: null, text: '', raw: 'guard_cancelled' };
      }
      launched = true;
      return { ok: true, exitCode: 0, text: 'late audit start', isolated: true, network: 'fake', image: 'fake', raw: '' };
    },
    killContainer: async () => {
      if (!launched) return { ok: true, confirmed: true, state: 'gone' };
      stopped = true;
      return { ok: true, confirmed: true, state: 'exited' };
    }
  };
  return { iso, started, release: () => release(), alive: () => launched && !stopped };
}

test('B01-C Audit 容器：取消已报告成功后不得迟到启动', async () => {
  const p = svc.createProject({ name: 'b01c', slug: `b01c-${Date.now().toString(36)}` });
  const repo = join(p.dir, 'repo');
  const head = gitRepo(repo);
  const t = svc.createTask({
    project: p.id,
    title: 'B01 audit',
    input: 'audit',
    kind: 'audit',
    executor: 'claude-code',
    executorConfig: { repo: 'repo', commit: head, contract: '# frozen contract' }
  });
  const barrier = auditBarrier();
  const running = svc.runTask(t.id, { isolation: barrier.iso });
  await barrier.started;

  const cancelling = svc.cancelTask(t.id, { isolation: barrier.iso });
  await waitForTaskStatus(t.id, ['cancel_requested', 'cancelled'], 'B01-C');
  barrier.release();
  const cancel = await cancelling;
  await running.catch(() => {});

  assert.equal(
    Boolean(cancel.ok) && barrier.alive(),
    false,
    `取消返回 ok=${cancel.ok} 后仍观察到 Audit 容器迟到启动 (task=${svc.getTask(t.id).status})`
  );
  const resources = svc.listResources(t.id);
  assert.ok(resources.some((r) => r.kind === 'audit' && r.state === 'abandoned'), JSON.stringify(resources));
  assert.equal(svc.getTask(t.id).status, 'cancelled');
});


function claudeInFlightBarrier() {
  let markStarted;
  let release;
  const started = new Promise((r) => { markStarted = r; });
  const hold = new Promise((r) => { release = r; });
  let launched = false;
  let stopped = false;
  const iso = {
    isolationStatus: async () => ({ available: true, backend: 'fake', image: 'fake', network: 'fake', networkInternal: true }),
    egressProxyUrl: async () => 'http://127.0.0.1:9',
    runClaudeIsolated: async ({ workdir, guard }) => {
      // 先取得 docker 启动许可（资源进入 started），再挂起，模拟启动进行中。
      const allowed = guard ? await guard() : true;
      if (!allowed) return { ok: false, cancelled: true, blocked: 'cancelled', exitCode: null, text: '', raw: 'guard_cancelled' };
      markStarted();
      await hold;
      launched = true;
      writeFileSync(join(workdir, 'feature.txt'), 'in-flight claude start\n');
      return { ok: true, exitCode: 0, text: 'in-flight', isolated: true, network: 'fake', image: 'fake', raw: '' };
    },
    runInWorkdir: async () => ({ ok: true, exitCode: 0, output: 'ok' }),
    killContainer: async () => {
      if (!launched) return { ok: true, confirmed: true, state: 'gone' };
      stopped = true;
      return { ok: true, confirmed: true, state: 'exited' };
    }
  };
  return { iso, started, release: () => release(), alive: () => launched && !stopped };
}

test('B01-QA-02 启动进行中取消：不得提前成功，必须等到可验证停止', async () => {
  const { t } = makeTask('b01inflight');
  const barrier = claudeInFlightBarrier();
  const running = svc.runTask(t.id, { isolation: barrier.iso });
  await barrier.started;

  const cancelling = svc.cancelTask(t.id, { isolation: barrier.iso });
  await waitForTaskStatus(t.id, ['cancel_requested', 'cancelled'], 'B01-QA-02');
  // 启动已进入 started 阶段；取消不能在没有 kill 证据时提前结束。
  barrier.release();
  const cancel = await cancelling;
  const result = await running;
  assert.equal(
    Boolean(cancel.ok) && barrier.alive(),
    false,
    `取消返回 ok=${cancel.ok} 后仍观察到进行中的执行容器存活 (task=${svc.getTask(t.id).status}, result=${result.blocked})`
  );
});


test('B01-QA-05a Docker 失联：不得把启动意图当作安全停止', async () => {
  const { t } = makeTask('b01daemon');
  const barrier = claudeBarrier();
  const iso = {
    ...barrier.iso,
    killContainer: async () => ({ ok: false, confirmed: false, reason: 'docker_daemon_unreachable' })
  };
  const running = svc.runTask(t.id, { isolation: iso });
  await barrier.started;
  const cancel = await svc.cancelTask(t.id, { isolation: iso, launchWaitMs: 500 });
  assert.equal(cancel.ok, false);
  assert.equal(svc.getTask(t.id).status, 'cancel_requested');
  const resources = svc.listResources(t.id);
  assert.ok(resources.every((r) => r.state === 'unknown'), JSON.stringify(resources));
  barrier.release();
  await running.catch(() => {});
  assert.equal(barrier.alive(), false);
});

test('B01-QA-05b 重启遗留 starting 意图：超时后必须 unknown 且取消未确认', async () => {
  const p = svc.createProject({ name: 'b01restart', slug: `b01restart-${Date.now().toString(36)}` });
  const t = svc.createTask({ project: p.id, title: 'restart', input: 'x' });
  svc.updateTask(t.id, { status: 'running' });
  const execId = `exe_b01restart_${Date.now().toString(36)}`;
  svc.db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, t.id, null, 'running', 'test', '', new Date().toISOString());
  svc.db()
    .prepare("INSERT INTO execution_resources (id,execution_id,task_id,kind,name,state,started_at) VALUES (?,?,?,?,?,?,?)")
    .run(`res_${execId}`, execId, t.id, 'claude', `jarvis-exec-${execId}`, 'starting', new Date().toISOString());

  const fakeIso = { killContainer: async () => ({ ok: true, confirmed: true, state: 'gone' }) };
  const cancel = await svc.cancelTask(t.id, { isolation: fakeIso, launchWaitMs: 120 });
  assert.equal(cancel.ok, false, '未解决的启动意图不得报告取消成功');
  assert.equal(svc.getTask(t.id).status, 'cancel_requested');
  const resource = svc.listResources(t.id)[0];
  assert.equal(resource.state, 'unknown');
  const execution = svc.db().prepare('SELECT * FROM executions WHERE id=?').get(execId);
  assert.equal(execution.status, 'running', '执行状态不得被伪造成 cancelled');
});

test('B01-QA-06 并发取消：不得产生新执行或错误终态', async () => {
  const { t } = makeTask('b01concurrent');
  const barrier = claudeBarrier();
  const running = svc.runTask(t.id, { isolation: barrier.iso });
  await barrier.started;
  const execBefore = svc.db().prepare('SELECT COUNT(*) AS n FROM executions WHERE task_id=?').get(t.id).n;
  const c1 = svc.cancelTask(t.id, { isolation: barrier.iso });
  const c2 = svc.cancelTask(t.id, { isolation: barrier.iso });
  await waitForTaskStatus(t.id, ['cancel_requested', 'cancelled'], 'B01-QA-06');
  barrier.release();
  const [r1, r2] = await Promise.all([c1, c2]);
  await running.catch(() => {});
  assert.ok(r1.ok || r1.already_cancelled, JSON.stringify(r1));
  assert.ok(r2.ok || r2.already_cancelled, JSON.stringify(r2));
  assert.equal(svc.getTask(t.id).status, 'cancelled');
  assert.equal(barrier.alive(), false);
  const execAfter = svc.db().prepare('SELECT COUNT(*) AS n FROM executions WHERE task_id=?').get(t.id).n;
  assert.equal(execAfter, execBefore, '并发取消不得创建新执行');
});
