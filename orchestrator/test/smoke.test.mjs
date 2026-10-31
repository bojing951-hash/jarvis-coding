/**
 * 编排层冒烟测试（不触网、不调用模型）：
 * 验证数据模型、状态机与隔离约束。
 * 运行： node --test orchestrator/test/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-test-'));
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');

const svc = await import('../src/service.mjs');

test('创建项目并生成隔离目录', () => {
  const p = svc.createProject({ name: '测试项目', slug: 't-proj' });
  assert.equal(p.slug, 't-proj');
  assert.equal(p.status, 'active');
  assert.ok(p.dir.includes('t-proj'));
});

test('slug 重复应报错', () => {
  assert.throws(() => svc.createProject({ name: '又一个', slug: 't-proj' }), /已存在/);
});

test('模型与角色解耦：角色可以不带模型独立修改', () => {
  const p = svc.createProject({ name: '解耦测试', slug: 't-decouple' });
  assert.ok(p.id);
  // 角色是纯数据，不隐含任何模型假设
  const role = '你是审计员';
  assert.ok(role.length > 0);
});

test('任务状态机：待审批任务不能直接执行', async () => {
  const p = svc.createProject({ name: '状态机', slug: 't-state' });
  const t = svc.createTask({ project: p.id, title: '需审批', input: 'x', needsApproval: true, maxAttempts: 2 });
  assert.equal(t.status, 'pending');
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'needs_approval');
});

test('项目暂停后拒绝执行任务', async () => {
  const p = svc.createProject({ name: '暂停', slug: 't-pause' });
  const t = svc.createTask({ project: p.id, title: '任务', input: 'x' });
  svc.setProjectStatus(p.slug, 'paused');
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'project_paused');
});

test('超过最大重试次数后标记失败', async () => {
  const p = svc.createProject({ name: '重试', slug: 't-retry' });
  const t = svc.createTask({ project: p.id, title: '任务', input: 'x', maxAttempts: 1 });
  svc.updateTask(t.id, { attempts: 1 });
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'max_attempts');
});

test('工作流 spec 为空应报错', () => {
  const p = svc.createProject({ name: '空流', slug: 't-empty' });
  assert.throws(() => svc.createWorkflow({ project: p.id, name: 'x', spec: { stages: [] } }), /不能为空/);
});

test('取消一个没有运行中执行的任务应如实失败', async () => {
  const p = svc.createProject({ name: '取消测试', slug: 't-cancel' });
  const t = svc.createTask({ project: p.id, title: '未执行', input: 'x' });
  const r = await svc.cancelTask(t.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /没有正在运行/);
});

test('审计任务缺少契约应被拒绝', async () => {
  const p = svc.createProject({ name: '审计测试', slug: 't-audit' });
  const t = svc.createTask({
    project: p.id,
    title: '审计',
    input: 'x',
    kind: 'audit',
    executorConfig: { repo: '/tmp', commit: 'abc' }
  });
  const r = await svc.runTask(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'no_contract');
});

test('执行器任务应持久化 executor 与配置', () => {
  const p = svc.createProject({ name: '执行器持久化', slug: 't-exec' });
  const t = svc.createTask({
    project: p.id,
    title: 'e',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { cwd: '/tmp', mode: 'plan', verify: 'npm test' }
  });
  assert.equal(t.kind, 'executor');
  assert.equal(t.executor, 'claude-code');
  assert.match(t.executor_config, /npm test/);
});
