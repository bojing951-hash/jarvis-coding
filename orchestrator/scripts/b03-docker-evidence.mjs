/**
 * B03-QA-04/05：真实 Docker 竞态证据的共用判定器。
 * 脚本与反向测试必须使用同一函数，不能各复制一份最终布尔表达式。
 */

export function isTrustedGoneInspect(result, containerName) {
  if (!result || result.ok === true) return false;
  if (result.abnormal === true || result.signal) return false;
  if (typeof result.status !== 'number') return false;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const escaped = String(containerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:No such object|No such container):\\s*${escaped}(?:\\s|$)`, 'i').test(text);
}

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
  require(e?.containerName === `jarvis-exec-${e?.executionId}`, 'container name does not match executionId');
  require(Boolean(e?.containerId), 'missing containerId');
  require(e?.sawContainerRunning === true, 'container was never observed running');
  require(Array.isArray(e?.observedStates) && e.observedStates.includes('running'), 'observedStates missing running');
  require(e?.eventsOk === true, `docker events query failed: ${e?.eventsError || 'unknown'}`);
  require(
    Array.isArray(e?.events) && ['create', 'start', 'die', 'destroy'].every((a) => e.events.includes(a)),
    `docker events incomplete: ${JSON.stringify(e?.events)}`
  );
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
