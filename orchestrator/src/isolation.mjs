/**
 * 隔离执行适配层（FIX1-C）。
 *
 * 真实隔离由容器提供；宿主机只提供任务所需的副本。
 * 本模块的职责是「证明」而不是「宣称」：
 * - 可用性通过实际探测（docker info）判断
 * - 不可用时一律 fail closed，不允许退回宿主机执行
 */
import { execFile } from 'node:child_process';

const DOCKER = process.env.JARVIS_DOCKER_BIN || 'docker';

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
  const image = process.env.JARVIS_EXECUTOR_IMAGE || '';
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
  return { available: true, backend: 'docker', serverVersion: info.out.trim(), image: img.out.trim() };
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
export async function runIsolated({ image, mount, workdir, command, args = [], timeoutMs = 900_000, network = 'none' }) {
  const st = await isolationStatus();
  if (!st.available) {
    return { ok: false, blocked: 'isolation_unavailable', error: st.reason };
  }
  const dockerArgs = [
    'run', '--rm',
    '--network', network,
    '--user', '1000:1000',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', '256',
    '--memory', '2g',
    '-v', `${mount}:/work:rw`,
    '-w', workdir || '/work',
    image,
    command,
    ...args
  ];
  const started = Date.now();
  const r = await sh(DOCKER, dockerArgs, { timeoutMs });
  return {
    ok: r.code === 0,
    exitCode: r.code,
    durationMs: Date.now() - started,
    output: r.out.slice(-8000),
    isolated: true,
    network,
    image
  };
}

/** 隔离不可用时的统一拒绝。 */
export function requireIsolation(status) {
  if (!status?.available) {
    return { ok: false, blocked: 'isolation_unavailable', error: status?.reason ?? '隔离环境不可用' };
  }
  return { ok: true };
}
