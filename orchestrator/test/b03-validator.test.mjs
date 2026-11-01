/**
 * B03-QA-05 / B04-QA-05：真实 Docker 证据验证器的反向测试。
 * 直接调用 verify-b01-docker-race.mjs 使用的同一判定函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDockerRaceEvidence, parseDockerEventLine } from '../scripts/b03-docker-evidence.mjs';

const ID = 'a'.repeat(64);
const NAME = 'jarvis-exec-exe_b03';
const BASE = 1_700_000_000_000;
const ns = (offsetMs) => String((BigInt(BASE) + BigInt(offsetMs)) * 1_000_000n);

const event = (action, offsetMs, over = {}) => ({
  type: 'container',
  action,
  actorId: ID,
  actorName: NAME,
  timeNano: ns(offsetMs),
  raw: '',
  ...over
});

const rawEvent = (e) => JSON.stringify({
  Type: e.type,
  Action: e.action,
  Actor: { ID: e.actorId, Attributes: { name: e.actorName } },
  timeNano: e.timeNano
});

const syncRaw = (e) => {
  e.eventsRaw = e.events.map(rawEvent).join('\n');
  return e;
};

const base = () => {
  const events = [
    event('create', 400),
    event('start', 500),
    event('die', 600),
    event('destroy', 700)
  ];
  return syncRaw({
    cancelResolvedBeforeRelease: false,
    cancelOk: true,
    taskStatus: 'cancelled',
    executionStatus: 'cancelled',
    resourceState: 'stopped',
    executionId: 'exe_b03',
    resourceName: NAME,
    containerName: NAME,
    containerId: ID,
    sawContainerRunning: true,
    observedStates: ['created', 'running'],
    eventsOk: true,
    eventsParseErrors: [],
    events,
    eventsRaw: '',
    startedAt: BASE,
    barrierAt: BASE + 100,
    cancelRequestedAt: BASE + 200,
    releaseAt: BASE + 300,
    cancelResolvedAt: BASE + 800,
    finalStateAt: BASE + 900,
    ps: { ok: true, status: 0, stdout: '', stderr: '', error: null, signal: null },
    inspectAfter: {
      ok: false,
      status: 1,
      stdout: '',
      stderr: `Error: No such object: ${NAME}`,
      error: null,
      signal: null,
      abnormal: false,
      trustedGone: true
    },
    gitHeadBefore: 'aaa',
    gitHeadAfter: 'aaa'
  });
};

test('B03-QA-05 完整结构化生命周期应通过', () => {
  const r = evaluateDockerRaceEvidence(base());
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

const mutations = [
  ['docker ps 非零退出', (e) => { e.ps.ok = false; e.ps.status = 1; e.ps.stderr = 'ps failed'; }],
  ['docker ps 仍有目标容器', (e) => { e.ps.stdout = `${NAME} Up`; }],
  ['最终 inspect running', (e) => { e.inspectAfter = { ok: true, status: 0, stdout: 'running', stderr: '', trustedGone: false, abnormal: false }; }],
  ['最终 inspect 异常', (e) => { e.inspectAfter = { ok: false, status: null, stdout: '', stderr: 'timeout', trustedGone: false, abnormal: true }; }],
  ['缺少 create', (e) => { e.events = e.events.filter((x) => x.action !== 'create'); }],
  ['缺少 destroy', (e) => { e.events = e.events.filter((x) => x.action !== 'destroy'); }],
  ['events 查询失败', (e) => { e.eventsOk = false; e.eventsError = 'ETIMEDOUT'; }],
  ['events 解析错误', (e) => { e.eventsParseErrors = ['bad json']; }],
  ['资源名不匹配', (e) => { e.resourceName = 'jarvis-exec-other'; }],
  ['容器名不匹配', (e) => { e.containerName = 'jarvis-exec-other'; }],
  ['Execution ID 缺失', (e) => { e.executionId = null; }],
  ['Container ID 缺失', (e) => { e.containerId = ''; }],
  ['Task cancelled 但 ps 仍运行', (e) => { e.ps.stdout = `${NAME} Up`; }],
  ['Git HEAD 变化', (e) => { e.gitHeadAfter = 'bbb'; }],
  ['取消提前确认', (e) => { e.cancelResolvedBeforeRelease = true; }],
  ['cancelTask 未成功', (e) => { e.cancelOk = false; }],
  ['资源未确认', (e) => { e.resourceState = 'unknown'; }],
  ['未观察运行', (e) => { e.sawContainerRunning = false; }],
  ['完全倒序事件', (e) => { e.events.reverse(); }],
  ['create/start 顺序错误', (e) => { const c = e.events.find((x) => x.action === 'create'); const s = e.events.find((x) => x.action === 'start'); [c.action, s.action] = [s.action, c.action]; }],
  ['die/destroy 顺序错误', (e) => { const d = e.events.find((x) => x.action === 'die'); const z = e.events.find((x) => x.action === 'destroy'); [d.action, z.action] = [z.action, d.action]; }],
  ['事件使用其他 Container ID', (e) => { e.events.find((x) => x.action === 'start').actorId = 'b'.repeat(64); }],
  ['混合其他容器事件', (e) => { e.events.push(event('start', 550, { actorId: 'b'.repeat(64) })); }],
  ['事件名与 Resource 不一致', (e) => { e.events.find((x) => x.action === 'die').actorName = 'other'; }],
  ['事件缺失 Actor.ID', (e) => { e.events.find((x) => x.action === 'start').actorId = null; }],
  ['事件缺失 timeNano', (e) => { e.events.find((x) => x.action === 'start').timeNano = null; }],
  ['事件非法 timeNano', (e) => { e.events.find((x) => x.action === 'start').timeNano = 'not-a-number'; }],
  ['时间戳逆序', (e) => { e.events.find((x) => x.action === 'start').timeNano = ns(300); }],
  ['die 晚于取消确认', (e) => { e.events.find((x) => x.action === 'die').timeNano = ns(850); }],
  ['destroy 晚于最终状态查询', (e) => { e.events.find((x) => x.action === 'destroy').timeNano = ns(950); }],
  ['create 早于屏障释放', (e) => { e.events.find((x) => x.action === 'create').timeNano = ns(200); }],
  ['重复 create', (e) => { e.events.push(event('create', 450)); }],
  ['destroy 后仍有目标事件', (e) => { e.events.push(event('start', 750)); }],
  ['timeline 缺失', (e) => { delete e.finalStateAt; }],
  ['raw JSONL 数量不匹配', (e) => { e.eventsRaw = rawEvent(e.events[0]); }],
  ['raw JSONL 解析失败', (e) => { e.eventsRaw = 'not json'; }]
];

for (const [name, mutate] of mutations) {
  test(`B04-QA-05 反向：${name} 必须 FAIL`, () => {
    const e = base();
    mutate(e);
    if (name !== 'raw JSONL 数量不匹配' && name !== 'raw JSONL 解析失败') syncRaw(e);
    const r = evaluateDockerRaceEvidence(e);
    assert.equal(r.ok, false, `${name} 不应通过`);
    assert.ok(r.failures.length > 0);
  });
}

test('B04-QA-01 timeNano 超过 Number.MAX_SAFE_INTEGER 仍精确保留', () => {
  const raw = '{"Type":"container","Action":"die","Actor":{"ID":"' + ID + '","Attributes":{"name":"' + NAME + '"}},"timeNano":"1700000000123456789"}';
  const ev = parseDockerEventLine(raw);
  assert.equal(ev.timeNano, '1700000000123456789');
  assert.equal(BigInt(ev.timeNano), 1_700_000_000_123_456_789n);
});

test('B04-QA-01 原始 JSONL 与结构化事件不一致不得通过', () => {
  const e = base();
  e.eventsRaw = rawEvent(e.events[0]);
  const r = evaluateDockerRaceEvidence(e);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((x) => /raw Docker events count/.test(x)));
});
