/**
 * B03-QA-05：真实 Docker 验证器的反向测试。
 * 直接调用 verify-b01-docker-race.mjs 使用的同一判定函数，不复制最终布尔表达式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDockerRaceEvidence, isTrustedGoneInspect } from '../scripts/b03-docker-evidence.mjs';

const base = () => ({
  cancelResolvedBeforeRelease: false,
  cancelOk: true,
  taskStatus: 'cancelled',
  executionStatus: 'cancelled',
  resourceState: 'stopped',
  executionId: 'exe_b03',
  containerName: 'jarvis-exec-exe_b03',
  containerId: 'container-id',
  sawContainerRunning: true,
  observedStates: ['created', 'running'],
  events: ['create', 'start', 'die', 'destroy'],
  eventsOk: true,
  eventsError: '',
  ps: { ok: true, status: 0, stdout: '', stderr: '', error: null, signal: null },
  inspectAfter: {
    ok: false,
    status: 1,
    stdout: '',
    stderr: 'Error: No such object: jarvis-exec-exe_b03',
    error: null,
    signal: null,
    abnormal: false,
    trustedGone: true
  },
  gitHeadBefore: 'aaa',
  gitHeadAfter: 'aaa'
});

test('B03-QA-05 完整真实 Docker 证据应通过', () => {
  const r = evaluateDockerRaceEvidence(base());
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

const mutations = [
  ['docker ps 非零退出', (e) => { e.ps.ok = false; e.ps.status = 1; e.ps.stderr = 'ps failed'; }],
  ['docker ps 仍有目标容器', (e) => { e.ps.stdout = 'jarvis-exec-exe_b03 Up'; }],
  ['最终 inspect running', (e) => { e.inspectAfter = { ok: true, status: 0, stdout: 'running', stderr: '', trustedGone: false, abnormal: false }; }],
  ['最终 inspect 异常无法确认', (e) => { e.inspectAfter = { ok: false, status: null, stdout: '', stderr: 'timeout', trustedGone: false, abnormal: true }; }],
  ['缺少 create 事件', (e) => { e.events = ['start', 'die', 'destroy']; }],
  ['缺少 destroy 事件', (e) => { e.events = ['create', 'start', 'die']; }],
  ['events 查询失败但部分输出含全部动作', (e) => { e.eventsOk = false; e.eventsError = 'ETIMEDOUT'; }],
  ['容器名与 Execution 不一致', (e) => { e.containerName = 'jarvis-exec-other'; }],
  ['缺少 Execution ID', (e) => { e.executionId = null; }],
  ['缺少容器 ID', (e) => { e.containerId = ''; }],
  ['Task cancelled 但 Docker 仍运行', (e) => { e.ps.stdout = 'jarvis-exec-exe_b03 Up 10 seconds'; }],
  ['Git HEAD 未经授权变化', (e) => { e.gitHeadAfter = 'bbb'; }],
  ['取消提前确认', (e) => { e.cancelResolvedBeforeRelease = true; }],
  ['cancelTask 未成功', (e) => { e.cancelOk = false; }],
  ['资源状态未确认', (e) => { e.resourceState = 'unknown'; }],
  ['未观察到容器运行', (e) => { e.sawContainerRunning = false; }]
];

for (const [name, mutate] of mutations) {
  test(`B03-QA-05 反向：${name} 必须 FAIL`, () => {
    const e = base();
    mutate(e);
    const r = evaluateDockerRaceEvidence(e);
    assert.equal(r.ok, false, `${name} 不应通过`);
    assert.ok(r.failures.length > 0);
  });
}

test('B03-QA-01 isTrustedGoneInspect：正常非零 No such 目标匹配才可信', () => {
  const ok = isTrustedGoneInspect({
    ok: false,
    status: 1,
    stdout: '',
    stderr: 'Error: No such object: jarvis-exec-exe_b03',
    abnormal: false,
    signal: null
  }, 'jarvis-exec-exe_b03');
  assert.equal(ok, true);
});

test('B03-QA-01 isTrustedGoneInspect：异常结束即使是 No such 也不可信', () => {
  const ok = isTrustedGoneInspect({
    ok: false,
    status: null,
    stdout: '',
    stderr: 'Error: No such object: jarvis-exec-exe_b03',
    abnormal: true,
    signal: 'SIGTERM'
  }, 'jarvis-exec-exe_b03');
  assert.equal(ok, false);
});

test('B03-QA-01 isTrustedGoneInspect：错误文本目标不匹配不可信', () => {
  const ok = isTrustedGoneInspect({
    ok: false,
    status: 1,
    stdout: '',
    stderr: 'Error: No such object: another-container',
    abnormal: false,
    signal: null
  }, 'jarvis-exec-exe_b03');
  assert.equal(ok, false);
});
