/**
 * B04-QA：真实 Docker 生命周期证据的共用判定器。
 * 脚本与反向测试必须使用同一函数，不能各复制一份最终布尔表达式。
 *
 * events 是结构化事件：
 *   { type, action, actorId, actorName, timeNano, raw }
 * timeNano 以字符串保存，避免超过 Number.MAX_SAFE_INTEGER 的精度损失。
 */

const REQUIRED = ['create', 'start', 'die', 'destroy'];
const HEX64 = /^[0-9a-f]{64}$/i;

export function isTrustedGoneInspect(result, containerName) {
  if (!result || result.ok === true) return false;
  if (result.abnormal === true || result.signal) return false;
  if (typeof result.status !== 'number') return false;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const escaped = String(containerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:No such object|No such container):\\s*${escaped}(?:\\s|$)`, 'i').test(text);
}

/** Docker JSON Lines → 结构化事件；timeNano 从原始行提取以保留完整数字。 */
export function parseDockerEventLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw) throw new Error('empty event line');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid Docker event JSON: ${e.message}`);
  }
  const timeMatch = raw.match(/"timeNano"\s*:\s*"?(\d+)"?/);
  const timeNano = timeMatch ? timeMatch[1] : (typeof obj.timeNano === 'string' ? obj.timeNano : null);
  const type = obj.Type ?? obj.type ?? null;
  const action = obj.Action ?? obj.status ?? null;
  const actorId = obj.Actor?.ID ?? obj.Actor?.Id ?? null;
  const actorName = obj.Actor?.Attributes?.name ?? obj.Actor?.Attributes?.Name ?? null;
  return { type, action, actorId, actorName, timeNano, raw };
}

function eventTime(ev) {
  if (!ev || typeof ev.timeNano !== 'string' || !/^\d+$/.test(ev.timeNano)) return null;
  const n = BigInt(ev.timeNano);
  return n > 0n ? n : null;
}

const ms = (timeNano) => timeNano / 1_000_000n;

export function evaluateDockerRaceEvidence(e) {
  const failures = [];
  const require = (condition, message) => {
    if (!condition) failures.push(message);
  };

  require(e && e.cancelResolvedBeforeRelease === false, 'cancel resolved before docker run release');
  require(e?.cancelOk === true, 'cancelTask did not return ok=true');
  require(e?.taskStatus === 'cancelled', `task status is ${e?.taskStatus}`);
  require(e?.executionStatus === 'cancelled', `execution status is ${e?.executionStatus}`);
  require(['stopped', 'abandoned'].includes(e?.resourceState), `resource state is ${e?.resourceState}`);
  require(Boolean(e?.executionId), 'missing executionId');
  require(e?.resourceName === `jarvis-exec-${e?.executionId}`, 'resource name does not match executionId');
  require(e?.containerName === `jarvis-exec-${e?.executionId}`, 'container name does not match executionId');
  require(typeof e?.containerId === 'string' && HEX64.test(e.containerId), 'containerId is not a full Docker ID');
  require(e?.sawContainerRunning === true, 'container was never observed running');
  require(Array.isArray(e?.observedStates) && e.observedStates.includes('running'), 'observedStates missing running');

  require(e?.eventsOk === true, `docker events stream failed: ${e?.eventsError || 'unknown'}`);
  require(Array.isArray(e?.eventsParseErrors) && e.eventsParseErrors.length === 0, 'raw Docker events contain parse errors');
  require(typeof e?.eventsRaw === 'string' && e.eventsRaw.trim().length > 0, 'raw Docker events are empty');
  require(Array.isArray(e?.events) && e.events.length > 0, 'no parsed Docker events');

  const events = Array.isArray(e?.events) ? e.events : [];
  if (typeof e?.eventsRaw === 'string') {
    const parsedRaw = [];
    let rawError = null;
    for (const line of e.eventsRaw.split('\n')) {
      if (!line.trim()) continue;
      try { parsedRaw.push(parseDockerEventLine(line)); } catch (err) { rawError = err.message; }
    }
    require(rawError === null, `raw Docker events parse error: ${rawError}`);
    require(parsedRaw.length === events.length, `raw Docker events count ${parsedRaw.length} != parsed ${events.length}`);
  }
  const target = events.filter(
    (ev) => ev.type === 'container' && ev.actorId === e.containerId && ev.actorName === e.containerName
  );
  const requiredAnywhere = events.filter((ev) => REQUIRED.includes(ev.action));
  const foreignRequired = requiredAnywhere.filter(
    (ev) => !(ev.type === 'container' && ev.actorId === e.containerId && ev.actorName === e.containerName)
  );
  require(foreignRequired.length === 0, `required events from another container: ${JSON.stringify(foreignRequired)}`);

  const required = target.filter((ev) => REQUIRED.includes(ev.action));
  for (const action of REQUIRED) {
    const count = required.filter((ev) => ev.action === action).length;
    require(count === 1, `required event count ${action}=${count}`);
  }

  const sequence = required.map((ev) => ev.action);
  require(
    JSON.stringify(sequence) === JSON.stringify(REQUIRED),
    `lifecycle order is ${JSON.stringify(sequence)}`
  );

  const byAction = Object.fromEntries(required.map((ev) => [ev.action, ev]));
  const times = {};
  for (const action of REQUIRED) {
    const ev = byAction[action];
    const t = eventTime(ev);
    times[action] = t;
    require(t !== null, `missing or invalid timeNano for ${action}`);
  }

  if (REQUIRED.every((a) => times[a] !== null)) {
    require(times.create <= times.start, 'timestamp create > start');
    require(times.start <= times.die, 'timestamp start > die');
    require(times.die <= times.destroy, 'timestamp die > destroy');
  }

  const startIdx = target.findIndex((ev) => ev.action === 'create');
  const destroyIdx = target.findIndex((ev) => ev.action === 'destroy');
  require(startIdx >= 0 && destroyIdx >= 0 && destroyIdx >= startIdx, 'target lifecycle indexes invalid');
  if (destroyIdx >= 0) {
    require(
      target.slice(destroyIdx + 1).length === 0,
      `target container has events after destroy: ${JSON.stringify(target.slice(destroyIdx + 1))}`
    );
  }

  const timelineFields = ['startedAt', 'barrierAt', 'cancelRequestedAt', 'releaseAt', 'cancelResolvedAt', 'finalStateAt'];
  for (const field of timelineFields) {
    require(Number.isFinite(e?.[field]), `missing timeline field ${field}`);
  }
  if (timelineFields.every((field) => Number.isFinite(e?.[field]))) {
    require(e.barrierAt >= e.startedAt, 'barrier before test start');
    require(e.cancelRequestedAt >= e.barrierAt, 'cancel requested before barrier');
    require(e.releaseAt >= e.cancelRequestedAt, 'release before cancel request');
    require(e.cancelResolvedAt >= e.releaseAt, 'cancel resolved before release');
    require(e.finalStateAt >= e.cancelResolvedAt, 'final state query before cancel resolution');

    if (REQUIRED.every((a) => times[a] !== null)) {
      const createMs = ms(times.create);
      const startMs = ms(times.start);
      const dieMs = ms(times.die);
      const destroyMs = ms(times.destroy);

      require(createMs >= BigInt(e.releaseAt), 'create event before barrier release');
      require(startMs >= BigInt(e.releaseAt), 'start event before barrier release');
      require(createMs >= BigInt(e.startedAt), 'create event before test start');
      require(dieMs <= BigInt(e.cancelResolvedAt), 'die event after cancel confirmation');
      require(destroyMs <= BigInt(e.finalStateAt), 'destroy event after final state query');
      require(createMs <= BigInt(e.finalStateAt), 'create event after final state query');
      require(startMs <= BigInt(e.finalStateAt), 'start event after final state query');
    }
  }

  require(e?.ps?.ok === true, 'docker ps command failed');
  require((e?.ps?.stdout || '').trim() === '', 'target container still appears in docker ps -a');
  require(Boolean(e?.inspectAfter), 'missing final docker inspect');
  require(
    e?.inspectAfter?.ok === true
      ? ['exited', 'dead', 'removing'].includes((e.inspectAfter.stdout || '').trim())
      : e?.inspectAfter?.trustedGone === true,
    `final inspect is not trusted stopped/gone: ${JSON.stringify(e?.inspectAfter)}`
  );
  require(e?.gitHeadBefore === e?.gitHeadAfter, 'git HEAD changed');

  return { ok: failures.length === 0, failures };
}
