/**
 * B04-QA-01～05：结构化 Docker 事件的身份、顺序、时间与原始 JSONL。
 * 直接调用实际共用验证器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDockerRaceEvidence, parseDockerEventLine } from '../scripts/b03-docker-evidence.mjs';

const ID = 'c'.repeat(64);
const NAME = 'jarvis-exec-exe_b04';
const BASE = 1_700_000_000_000;
const ns = (offset) => String((BigInt(BASE) + BigInt(offset)) * 1_000_000n);
const raw = (e) => JSON.stringify({
  Type: e.type,
  Action: e.action,
  Actor: { ID: e.actorId, Attributes: { name: e.actorName } },
  timeNano: e.timeNano
});
const ev = (action, offset, over = {}) => ({
  type: 'container', action, actorId: ID, actorName: NAME, timeNano: ns(offset), ...over
});
const base = () => {
  const events = [ev('create', 400), ev('start', 500), ev('die', 600), ev('destroy', 700)];
  return {
    cancelResolvedBeforeRelease: false,
    cancelOk: true,
    taskStatus: 'cancelled',
    executionStatus: 'cancelled',
    resourceState: 'stopped',
    executionId: 'exe_b04',
    resourceName: NAME,
    containerName: NAME,
    containerId: ID,
    sawContainerRunning: true,
    observedStates: ['created', 'running'],
    eventsOk: true,
    eventsParseErrors: [],
    events,
    eventsRaw: events.map(raw).join('\n'),
    startedAt: BASE,
    barrierAt: BASE + 100,
    cancelRequestedAt: BASE + 200,
    releaseAt: BASE + 300,
    cancelResolvedAt: BASE + 800,
    finalStateAt: BASE + 900,
    ps: { ok: true, status: 0, stdout: '', stderr: '' },
    inspectAfter: { ok: false, status: 1, stdout: '', stderr: `No such object: ${NAME}`, trustedGone: true, abnormal: false },
    gitHeadBefore: 'a',
    gitHeadAfter: 'a'
  };
};
const sync = (e) => { e.eventsRaw = e.events.map(raw).join('\n'); return e; };

test('B04-QA-01 timeNano 完整保留', () => {
  const e = parseDockerEventLine('{"Type":"container","Action":"die","Actor":{"ID":"' + ID + '","Attributes":{"name":"' + NAME + '"}},"timeNano":"1700000000123456789"}');
  assert.equal(e.timeNano, '1700000000123456789');
  assert.equal(BigInt(e.timeNano), 1700000000123456789n);
});

test('B04-QA-02 正常同容器生命周期通过', () => {
  const r = evaluateDockerRaceEvidence(base());
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('B04-QA-02 混合其他容器事件失败', () => {
  const e = base();
  e.events.push(ev('start', 550, { actorId: 'd'.repeat(64) }));
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-02 容器 ID 与资源不一致失败', () => {
  const e = base();
  e.events.find((x) => x.action === 'start').actorId = 'd'.repeat(64);
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-03 完全倒序事件失败', () => {
  const e = base();
  e.events.reverse();
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-03 缺少 timeNano 失败', () => {
  const e = base();
  e.events.find((x) => x.action === 'die').timeNano = null;
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-03 时间戳逆序失败', () => {
  const e = base();
  e.events.find((x) => x.action === 'start').timeNano = ns(300);
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-04 die 晚于取消确认失败', () => {
  const e = base();
  e.events.find((x) => x.action === 'die').timeNano = ns(850);
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-04 create 早于屏障释放失败', () => {
  const e = base();
  e.events.find((x) => x.action === 'create').timeNano = ns(200);
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-04 destroy 后仍有目标事件失败', () => {
  const e = base();
  e.events.push(ev('start', 750));
  sync(e);
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-05 原始 JSONL 解析失败 FAIL', () => {
  const e = base();
  e.eventsRaw = 'not json';
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});

test('B04-QA-05 events 查询失败 FAIL', () => {
  const e = base();
  e.eventsOk = false;
  e.eventsError = 'ETIMEDOUT';
  assert.equal(evaluateDockerRaceEvidence(e).ok, false);
});
