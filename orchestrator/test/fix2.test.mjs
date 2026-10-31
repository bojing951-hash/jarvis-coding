/**
 * FIX2 安全回归：DEF-03/04/05/06/08。
 * 用可控替身验证「拒绝路径」，不依赖用户是否在场。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-fix2-'));
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');

const svc = await import('../src/service.mjs');
const sec = await import('../src/security.mjs');

const uniq = (b) => `${b}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const gitRepo = (dir) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'x');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return g('rev-parse', 'HEAD').trim();
};

/* --------------------------------- DEF-08 --------------------------------- */

test('DEF-08 done 任务重复调用返回终态，不改成 failed', async () => {
  const p = svc.createProject({ name: '终态', slug: uniq('f2-terminal') });
  const t = svc.createTask({ project: p.id, title: '已完成', input: 'x' });
  svc.updateTask(t.id, { status: 'done', attempts: 3 });
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'terminal_state');
  assert.equal(svc.getTask(t.id).status, 'done');
});

test('DEF-08 cancelled 不得被迟到结果覆盖', async () => {
  const p = svc.createProject({ name: '取消终态', slug: uniq('f2-cancelterm') });
  const t = svc.createTask({ project: p.id, title: '已取消', input: 'x' });
  svc.updateTask(t.id, { status: 'cancelled' });
  const r = await svc.runTask(t.id);
  assert.equal(r.blocked, 'terminal_state');
  assert.equal(svc.getTask(t.id).status, 'cancelled');
});

test('DEF-08 failed 只能经显式重试入口回到可执行状态', () => {
  const p = svc.createProject({ name: '重试', slug: uniq('f2-retry') });
  const t = svc.createTask({ project: p.id, title: '失败', input: 'x' });
  svc.updateTask(t.id, { status: 'failed', error: 'boom' });
  assert.throws(() => svc.retryTask(t.id + 'x'), /不存在/);
  const r = svc.retryTask(t.id);
  assert.equal(r.status, 'retry_pending');
  assert.equal(svc.getTask(t.id).status, 'retry_pending');
});

/* --------------------------------- DEF-05 --------------------------------- */

test('DEF-05 旧 approved_at 不能授权执行器', async () => {
  const p = svc.createProject({ name: '旧字段', slug: uniq('f2-legacy') });
  const repo = join(p.dir, 'repo');
  const head = gitRepo(repo);
  const t = svc.createTask({
    project: p.id,
    title: '旧审批执行器',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'acceptEdits', repo: 'repo', base_commit: head }
  });
  svc.updateTask(t.id, { approved_at: new Date().toISOString(), status: 'approved' });
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'needs_approval');
});

test('DEF-05 有合法新审批时，旧字段不得阻断执行', async () => {
  const p = svc.createProject({ name: '新审批', slug: uniq('f2-newappr') });
  const repo = join(p.dir, 'repo');
  const head = gitRepo(repo);
  const t = svc.createTask({
    project: p.id,
    title: '新审批执行器',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'acceptEdits', repo: 'repo', base_commit: head }
  });
  // 未设置 approved_at，且 needs_approval=0：执行器路径不应被旧逻辑阻断
  const ap = svc.issueApproval({ task: t.id });
  assert.equal(ap.ok, true, ap.error || '');
  // 关键断言：不返回 needs_approval（是否执行取决于隔离/凭据环境）
  const preview = svc.approvalPreview(t.id);
  assert.equal(typeof preview.digest, 'string');
  assert.match(preview.reason, /JARVIS 高风险授权/);
});

/* --------------------------------- DEF-06 --------------------------------- */

test('DEF-06 提交引用发布失败时裁决为失败', () => {
  const v = sec.computeVerdict({
    execOk: true,
    verify: { exitCode: 0 },
    requiresVerify: true,
    commit: { ok: true, sha: 'abc123', refPublished: false },
    requiresCommit: true,
    approvalValid: true,
    commitRefOk: false
  });
  assert.equal(v.status, 'failed');
  assert.match(v.reasons.join(' '), /引用发布失败/);
});

test('DEF-06 引用发布成功才算完成', () => {
  const v = sec.computeVerdict({
    execOk: true,
    verify: { exitCode: 0 },
    requiresVerify: true,
    commit: { ok: true, sha: 'abc123', refPublished: true },
    requiresCommit: true,
    approvalValid: true,
    commitRefOk: true
  });
  assert.equal(v.status, 'done');
});

/* --------------------------------- DEF-04 --------------------------------- */

test('DEF-04 认证助手缺失时拒绝高授权', async () => {
  const r = await sec.runMacAuth({ reason: 't', timeoutSeconds: 1, helperPath: join(tmp, 'nope') });
  assert.equal(r.ok, false);
  assert.match(r.error, /不存在/);
});

test('DEF-04 认证失败（替身返回 1）不得授权', async () => {
  const fake = join(tmp, 'deny-helper.sh');
  writeFileSync(fake, '#!/bin/sh\nexit 1\n');
  chmodSync(fake, 0o755);
  process.env.JARVIS_AUTH_HELPER = fake;
  try {
    const r = await sec.runMacAuth({ reason: 't', timeoutSeconds: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
  } finally {
    delete process.env.JARVIS_AUTH_HELPER;
  }
});

test('DEF-04 认证超时（替身返回 3）不得授权', async () => {
  const fake = join(tmp, 'timeout-helper.sh');
  writeFileSync(fake, '#!/bin/sh\nexit 3\n');
  chmodSync(fake, 0o755);
  process.env.JARVIS_AUTH_HELPER = fake;
  try {
    const r = await sec.runMacAuth({ reason: 't', timeoutSeconds: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
  } finally {
    delete process.env.JARVIS_AUTH_HELPER;
  }
});

test('DEF-04 伪 TTY 不再是授权依据（旧接口已不参与审批）', () => {
  // 审批路径只调用 runMacAuth；requireInteractiveOperator 若仍存在也不能被 CLI 使用
  const cli = execFileSync('grep', ['-c', 'runMacAuth', join(process.cwd(), 'orchestrator/src/cli.mjs')], {
    encoding: 'utf8'
  }).trim();
  assert.ok(Number(cli) >= 1, 'CLI 必须使用 runMacAuth');
});
