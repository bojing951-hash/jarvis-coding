/**
 * 隔离执行适配层（FIX1-C）。
 *
 * 真实隔离由容器提供；宿主机只提供任务所需的副本。
 * 本模块的职责是「证明」而不是「宣称」：
 * - 可用性通过实际探测（docker info）判断
 * - 不可用时一律 fail closed，不允许退回宿主机执行
 */
import { execFile } from 'node:child_process';

import { existsSync } from 'node:fs';

const DOCKER_CANDIDATES = [
  process.env.JARVIS_DOCKER_BIN,
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker'
].filter(Boolean);

function dockerBin() {
  for (const c of DOCKER_CANDIDATES) if (existsSync(c)) return c;
  return 'docker';
}
const DOCKER = dockerBin();

const sh = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, out: (stdout || '') + (stderr || '') })
    );
  });

/** 实际探测 Docker 守护进程，而不是只看命令是否存在。 */
export async function isolationStatus() {
  const bin = await sh('/bin/sh', ['-c', `command -v ${DOCKER}`]).catch(() => ({ code: 1, out: '' }));
  if (bin.code !== 0) {
    return { available: false, backend: 'docker', reason: 'docker 命令不存在' };
  }
  const info = await sh(DOCKER, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 });
  if (info.code !== 0) {
    return { available: false, backend: 'docker', reason: `docker 守护进程不可用: ${info.out.slice(0, 200)}` };
  }
  const image = process.env.JARVIS_EXECUTOR_IMAGE || 'jarvis-executor:2.1.104';
  if (!image) {
    return {
      available: false,
      backend: 'docker',
      serverVersion: info.out.trim(),
      reason: '未配置 JARVIS_EXECUTOR_IMAGE（缺少含 Claude Code 的执行镜像）'
    };
  }
  const img = await sh(DOCKER, ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 15_000 });
  if (img.code !== 0) {
    return { available: false, backend: 'docker', serverVersion: info.out.trim(), reason: `执行镜像不可用: ${image}` };
  }
  const net = process.env.JARVIS_EXECUTOR_NETWORK || 'jarvis-internal';
  const netCheck = await sh(DOCKER, ['network', 'inspect', net, '--format', '{{.Internal}}'], { timeoutMs: 10_000 });
  if (netCheck.code !== 0) {
    return { available: false, backend: 'docker', serverVersion: info.out.trim(), image: img.out.trim(), reason: `隔离网络不存在: ${net}` };
  }
  const internal = netCheck.out.trim() === 'true';
  // DEF-03：策略要求内部隔离网络。Internal=false 意味着存在外网路由，必须 fail closed。
  if (!internal) {
    return {
      available: false,
      backend: 'docker',
      serverVersion: info.out.trim(),
      image: img.out.trim(),
      network: net,
      networkInternal: false,
      reason: `隔离网络 ${net} 的 Internal=false（存在外网路由），拒绝执行`
    };
  }
  return {
    available: true,
    backend: 'docker',
    serverVersion: info.out.trim(),
    image: img.out.trim(),
    network: net,
    networkInternal: true
  };
}

/**
 * 在容器内执行命令。
 *
 * 安全约束：
 * - --network=none 或指定受控网络
 * - 只挂载任务工作副本（:rw）与只读输入
 * - 不挂载 docker socket、不挂载用户目录、不传宿主机密钥
 * - 非 root 用户
 */
/**
 * 在隔离容器里运行 Claude Code。
 *
 * 安全要点：
 * - 只挂载一次性工作树（rw）与只读凭据文件
 * - 不挂载宿主用户目录、不挂载 docker socket
 * - 使用 --internal 网络，唯一出口是白名单代理
 * - 容器内非 root、drop 全部 capability、限制 pid 与内存
 */
/** 发现白名单代理在隔离网络内的地址。 */
export async function egressProxyUrl(network = process.env.JARVIS_EXECUTOR_NETWORK || 'jarvis-internal') {
  const name = process.env.JARVIS_PROXY_CONTAINER || 'jarvis-proxy';
  const r = await sh(DOCKER, ['inspect', name, '--format', '{{json .NetworkSettings.Networks}}'], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  try {
    const nets = JSON.parse(r.out.trim());
    return nets?.[network]?.IPAddress ? `http://${nets[network].IPAddress}:8888` : null;
  } catch {
    return null;
  }
}

export async function runClaudeIsolated({
  workdir,
  prompt,
  mode = 'plan',
  image,
  credentialsFile,
  proxyUrl,
  modelToken,
  name,
  readOnly = false,
  tmpDir,
  network = process.env.JARVIS_EXECUTOR_NETWORK || 'jarvis-internal',
  timeoutMs = 900_000
}) {
  const st = await isolationStatus();
  if (!st.available) return { ok: false, blocked: 'isolation_unavailable', error: st.reason };

  const args = [
    'run', '--rm',
    ...(name ? ['--name', name] : []),
    '--network', network,
    '--user', '1000:1000',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '256',
    '--memory', '2g',
    '-v', `${workdir}:/work:${readOnly ? 'ro' : 'rw'}`,
    ...(tmpDir ? ['-v', `${tmpDir}:/tmp:rw`] : []),
    '-w', '/work'
  ];
  if (credentialsFile) args.push('-v', `${credentialsFile}:/run/secrets/glm.env:ro`);
  // 不再注入 HTTP(S)_PROXY：模型流量通过 ANTHROPIC_BASE_URL 指向代理，
  // 直接走内网 IP；其余出网在 --internal 网络里本就没有路由。
  if (modelToken) args.push('-e', `JARVIS_MODEL_TOKEN=${modelToken}`);
  args.push(image, '-p', prompt, '--output-format', 'json', '--permission-mode', mode);

  const started = Date.now();
  const r = await sh(DOCKER, args, { timeoutMs });
  let parsed = null;
  const at = r.out.indexOf('{');
  if (at >= 0) {
    try { parsed = JSON.parse(r.out.slice(at)); } catch { parsed = null; }
  }
  return {
    ok: r.code === 0,
    exitCode: r.code,
    durationMs: Date.now() - started,
    text: parsed?.result ?? r.out.slice(-4000),
    isolated: true,
    network,
    image,
    raw: r.out.slice(-2000)
  };
}

/** 强制终止容器（取消用）；以容器实际消失为准。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 确认 Docker daemon 是否可用（与「容器不存在」区分）。 */
export async function daemonReachable() {
  const r = await sh(DOCKER, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 8_000 });
  return r.code === 0;
}

/**
 * 终止容器并确认。三种结果严格区分（DEF-01）：
 *  - confirmed=true             容器已退出/消失，且 daemon 健康
 *  - reason=docker_daemon_unreachable  daemon 失联，终止结果无法确认
 *  - reason=container_still_running    daemon 健康但容器仍在
 */
export async function killContainer(name, { graceMs = 5000 } = {}) {
  if (!name) return { ok: false, confirmed: false, reason: 'no_container_name' };

  const inspectState = async () => {
    const r = await sh(DOCKER, ['inspect', name, '--format', '{{.State.Status}}'], { timeoutMs: 8_000 });
    if (r.code === 0) return { kind: 'state', value: r.out.trim() };
    if (/No such object|could not be found/i.test(r.out)) return { kind: 'gone' };
    if (/Cannot connect|daemon|connection refused/i.test(r.out)) return { kind: 'daemon' };
    return { kind: 'error', value: r.out.slice(0, 120) };
  };

  if (!(await daemonReachable())) {
    return { ok: false, confirmed: false, reason: 'docker_daemon_unreachable', error: '无法连接 Docker daemon，终止结果无法确认' };
  }

  const STOPPED = new Set(['exited', 'dead', 'removing']);

  // 1) 先请求优雅终止（SIGTERM）
  await sh(DOCKER, ['kill', '--signal', 'TERM', name], { timeoutMs: 15_000 });

  let escalated = false;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const st = await inspectState();
    if (st.kind === 'gone') return { ok: true, confirmed: true, state: 'gone', escalated };
    if (st.kind === 'daemon') return { ok: false, confirmed: false, reason: 'docker_daemon_unreachable' };
    if (st.kind === 'state' && STOPPED.has(st.value)) return { ok: true, confirmed: true, state: st.value, escalated };
    if (st.kind === 'state' && !['running', 'created', 'restarting', 'paused'].includes(st.value)) {
      // 未知状态：不得判为已停止（FIX3-E）
      return { ok: false, confirmed: false, reason: 'unknown_container_state', state: st.value, escalated };
    }
    await sleep(200);
  }

  // 2) 仍未退出 → 升级 SIGKILL
  escalated = true;
  await sh(DOCKER, ['kill', '--signal', 'KILL', name], { timeoutMs: 15_000 });
  for (let i = 0; i < 25; i++) {
    const st = await inspectState();
    if (st.kind === 'gone') return { ok: true, confirmed: true, state: 'gone', escalated };
    if (st.kind === 'daemon') return { ok: false, confirmed: false, reason: 'docker_daemon_unreachable', escalated };
    if (st.kind === 'state' && STOPPED.has(st.value)) return { ok: true, confirmed: true, state: st.value, escalated };
    if (st.kind === 'state' && !['running', 'created', 'restarting', 'paused'].includes(st.value)) {
      return { ok: false, confirmed: false, reason: 'unknown_container_state', state: st.value, escalated };
    }
    await sleep(200);
  }
  return { ok: false, confirmed: false, reason: 'container_still_running', escalated };
}

/** 在同一隔离网络/挂载里运行任意受控程序（校验用）。 */
export async function runInWorkdir({ workdir, program, args = [], image, name, readOnly = false, network = process.env.JARVIS_EXECUTOR_NETWORK || 'jarvis-internal', timeoutMs = 300_000 }) {
  const st = await isolationStatus();
  if (!st.available) return { ok: false, blocked: 'isolation_unavailable', error: st.reason };
  const dockerArgs = [
    'run', '--rm',
    ...(name ? ['--name', name] : []),
    '--network', network,
    '--user', '1000:1000',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '256',
    '--memory', '2g',
    '-v', `${workdir}:/work:${readOnly ? 'ro' : 'rw'}`,
    '-w', '/work',
    '--entrypoint', program,
    image,
    ...args
  ];
  const started = Date.now();
  const r = await sh(DOCKER, dockerArgs, { timeoutMs });
  return { ok: r.code === 0, exitCode: r.code, durationMs: Date.now() - started, output: r.out.slice(-4000) };
}

/** 隔离不可用时的统一拒绝。 */
export function requireIsolation(status) {
  if (!status?.available) {
    return { ok: false, blocked: 'isolation_unavailable', error: status?.reason ?? '隔离环境不可用' };
  }
  return { ok: true };
}
