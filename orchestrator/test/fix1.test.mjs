/**
 * FIX1 回归测试：统一裁决、状态机、隔离 fail-closed、拒绝证据、审批身份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTestAuthKey } from './helpers/auth.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-fix1-'));
process.env.HOME = tmp;
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');
const auth = installTestAuthKey(tmp);

const svc = await import('../src/service.mjs');
const sec = await import('../src/security.mjs');

/* ------------------------------ DEF-01 裁决 ------------------------------- */

test('裁决：执行成功但校验失败 → failed', () => {
  const v = sec.computeVerdict({
    execOk: true,
    verify: { exitCode: 1 },
    requiresVerify: true,
    commit: null,
    requiresCommit: false,
    approvalValid: true
  });
  assert.equal(v.status, 'failed');
  assert.match(v.reasons.join(' '), /校验失败/);
});

test('裁决：执行成功、校验通过、提交成功 → done', () => {
  const v = sec.computeVerdict({
    execOk: true,
    verify: { exitCode: 0 },
    requiresVerify: true,
    commit: { ok: true, sha: 'abc123' },
    requiresCommit: true,
    approvalValid: true
  });
  assert.equal(v.status, 'done');
});

test('裁决：提交失败不得判为成功', () => {
  const v = sec.computeVerdict({
    execOk: true,
    verify: { exitCode: 0 },
    requiresVerify: true,
    commit: { ok: false, error: 'nothing to commit' },
    requiresCommit: true,
    approvalValid: true
  });
  assert.equal(v.status, 'failed');
});

test('裁决：缺少提交 SHA 不得判为成功', () => {
  const v = sec.computeVerdict({
    execOk: true,
    verify: { exitCode: 0 },
    requiresVerify: true,
    commit: { ok: true },
    requiresCommit: true,
    approvalValid: true
  });
  assert.equal(v.status, 'failed');
});

test('裁决：取消优先于其它结果', () => {
  const v = sec.computeVerdict({ cancelled: true, execOk: true });
  assert.equal(v.status, 'cancelled');
});

/* ------------------------------ 隔离 fail closed --------------------------- */

test('写模式缺少工作树规格被拒绝（DEF-07）', async () => {
  const p = svc.createProject({ name: '隔离门禁', slug: 'fix1-iso' });
  const t = svc.createTask({
    project: p.id,
    title: '写任务',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'acceptEdits' }
  });
  const ap = auth.issueApproval(svc, t.id);
  assert.equal(ap.ok, true, ap.error || '');
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.ok(['missing_worktree_spec', 'isolation_unavailable'].includes(r.blocked), `实际: ${r.blocked}`);
});

test('隔离状态探测返回结构化结果', async () => {
  const iso = await import('../src/isolation.mjs');
  const st = await iso.isolationStatus();
  assert.equal(typeof st.available, 'boolean');
  if (!st.available) assert.ok(st.reason.length > 0);
});

/* ------------------------------ 拒绝也要留证据 ----------------------------- */

test('执行器启动前被拒绝也留下 execution 记录', async () => {
  const p = svc.createProject({ name: '拒绝证据', slug: 'fix1-evd' });
  const t = svc.createTask({
    project: p.id,
    title: '无审批写任务',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'acceptEdits' }
  });
  await svc.runTask(t.id);
  const rows = svc.db().prepare('SELECT status, error, evidence FROM executions WHERE task_id = ?').all(t.id);
  assert.ok(rows.length >= 1, '必须留下拒绝记录');
  assert.equal(rows[0].status, 'rejected');
  const ev = JSON.parse(rows[0].evidence);
  assert.ok(ev.blocked);
  assert.ok(ev.phase);
});

test('非法执行器配置在解析阶段即被拒绝并留证据', async () => {
  const p = svc.createProject({ name: '非法配置', slug: 'fix1-bad' });
  const t = svc.createTask({
    project: p.id,
    title: '带 verify 的任务',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'plan', verify: 'sh -c id' }
  });
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'invalid_executor_config');
  const rows = svc.db().prepare('SELECT status FROM executions WHERE task_id = ?').all(t.id);
  assert.equal(rows[0].status, 'rejected');
});

/* ------------------------------ 审批身份 ---------------------------------- */

test('无 TTY 时不能签发审批', () => {
  assert.throws(() => sec.requireInteractiveOperator('APPROVE'), /TTY/);
});

test('有 TTY 但未确认时不能签发审批', () => {
  assert.throws(() => sec.requireInteractiveOperator(undefined), /TTY|APPROVE/);
});

/* --------------------------- CLI/MCP 契约一致 ------------------------------ */

test('白名单外的执行器字段一律拒绝（CLI 与 MCP 同源）', () => {
  for (const bad of ['approved', 'verify', 'allowedTools', 'allow_tools', 'shell']) {
    const v = sec.validateExecutorConfig({ mode: 'plan', [bad]: true });
    assert.equal(v.ok, false, `${bad} 应被拒绝`);
  }
});

test('白名单内的字段可正常通过', () => {
  const v = sec.validateExecutorConfig({
    cwd: 'sub',
    mode: 'plan',
    verify_profile_id: 'vpr_x',
    commit: false,
    commit_paths: ['src/a.mjs']
  });
  assert.equal(v.ok, true);
});
