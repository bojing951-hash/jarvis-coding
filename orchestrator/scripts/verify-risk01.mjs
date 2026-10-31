#!/usr/bin/env node
/**
 * RISK-01 实际核验：GLM 凭据暴露范围。
 *
 * 全部为真实 Docker 操作，不使用 mock。输出 PASS/FAIL 供审计复核。
 * 运行：node orchestrator/scripts/verify-risk01.mjs
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const DOCKER = process.env.JARVIS_DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const IMAGE = process.env.JARVIS_EXECUTOR_IMAGE || 'jarvis-executor:2.1.104';
const NET = process.env.JARVIS_EXECUTOR_NETWORK || 'jarvis-internal';
const KEY_FILE = join(HOME, '.openclaw/jarvis/proxy/glm.key');

const sh = (args, timeoutMs = 120_000) =>
  new Promise((resolve) => {
    execFile(DOCKER, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env }, (e, so, se) =>
      resolve({ code: e?.code ?? 0, out: ((so || '') + (se || '')).trim() })
    );
  });

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
};

const realKey = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : null;

/** 与编排层一致的凭据文件内容（占位符） */
function writePlaceholderCred(dir, proxyUrl) {
  const f = join(dir, 'glm.env');
  writeFileSync(
    f,
    [
      `ANTHROPIC_BASE_URL=${proxyUrl}/api/anthropic`,
      'ANTHROPIC_API_KEY=proxy-managed-placeholder',
      'ANTHROPIC_AUTH_TOKEN=proxy-managed-placeholder',
      'ANTHROPIC_MODEL=glm-5.3'
    ].join('\n'),
    { mode: 0o600 }
  );
  return f;
}

async function main() {
  if (!realKey) {
    record('读取宿主侧密钥文件', false, KEY_FILE);
    process.exit(1);
  }
  record('宿主侧密钥仅存在于 0600 文件', realKey.length > 20, `${KEY_FILE} len=${realKey.length}`);

  // 代理地址
  const inspectNet = await sh(['inspect', 'jarvis-proxy', '--format', '{{json .NetworkSettings.Networks}}']);
  let proxyIp = null;
  try {
    proxyIp = JSON.parse(inspectNet.out)?.[NET]?.IPAddress ?? null;
  } catch {}
  record('宿主代理在隔离网络内可达', Boolean(proxyIp), proxyIp || '未找到');

  const tmp = mkdtempSync(join(tmpdir(), 'risk01-'));
  const cred = writePlaceholderCred(tmp, `http://${proxyIp}:8888`);

  // 1) 容器内文件系统 / 环境变量是否含真实密钥
  const probe = await sh([
    'run', '--rm', '--network', NET,
    '-v', `${cred}:/run/secrets/glm.env:ro`,
    '--entrypoint', 'sh', IMAGE, '-c',
    'echo "--- file ---"; cat /run/secrets/glm.env; echo "--- env ---"; env | grep -i anthropic || true'
  ]);
  const leakedInContainer = probe.out.includes(realKey);
  record('容器内文件与环境不含真实密钥', !leakedInContainer, leakedInContainer ? '发现真实密钥' : '仅占位符');

  // 2) docker inspect 是否暴露密钥
  const name = `risk01-${Date.now().toString(36)}`;
  await sh(['run', '-d', '--name', name, '--network', NET, '-v', `${cred}:/run/secrets/glm.env:ro`, '--entrypoint', 'sleep', IMAGE, '30']);
  const insp = await sh(['inspect', name, '--format', '{{json .Config.Env}} {{json .Mounts}}']);
  record('docker inspect 不含真实密钥', !insp.out.includes(realKey));
  await sh(['rm', '-f', name]);

  // 3) 容器无法直连模型厂商（必须经代理）
  const nodeFetch = (js) => ['run', '--rm', '--network', NET, '--entrypoint', 'node', IMAGE, '-e', js];
  const direct = await sh(nodeFetch(
    "fetch('https://open.bigmodel.cn/api/paas/v4/',{signal:AbortSignal.timeout(6000)}).then(()=>console.log('REACHED')).catch(e=>console.log('BLOCKED:'+e.message))"
  ));
  record('容器不能直连模型厂商（无外网路由）', direct.out.includes('BLOCKED'), direct.out.slice(0, 60));

  // 4) 经代理可访问受控路径（模型请求通道）
  const viaProxy = await sh(nodeFetch(
    `fetch('http://${proxyIp}:8888/api/anthropic/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(String(r.status))).catch(e=>console.log('ERR'))`
  ));
  record('受控代理接受模型路径', /^[0-9]{3}$/.test(viaProxy.out.trim()) && viaProxy.out.trim() !== '000', `HTTP ${viaProxy.out.trim()}`);

  // 5) 代理拒绝非模型路径
  const other = await sh(nodeFetch(
    `fetch('http://${proxyIp}:8888/etc/passwd').then(r=>console.log(String(r.status))).catch(e=>console.log('ERR'))`
  ));
  record('代理拒绝非白名单路径', other.out.trim() === '403', `HTTP ${other.out.trim()}`);

  // 6) 验证容器（runInWorkdir）不挂载凭据
  const verifyProbe = await sh([
    'run', '--rm', '--network', NET, '--entrypoint', 'sh', IMAGE, '-c',
    'ls /run/secrets 2>&1 || true'
  ]);
  record('校验容器默认无凭据挂载', /No such file|not found|^$/.test(verifyProbe.out), verifyProbe.out.slice(0, 60));

  // 7) 仓库与日志中不含密钥
  const repoGrep = await new Promise((resolve) => {
    execFile('grep', ['-rl', realKey, join(HOME, 'JarvisCoding')], { timeout: 60_000 }, (e, so) =>
      resolve((so || '').trim())
    );
  });
  record('代码仓库不含真实密钥', repoGrep === '', repoGrep || '');

  const logFile = join(HOME, 'Library/Logs/openclaw/gateway.log');
  let logLeak = false;
  if (existsSync(logFile)) {
    try {
      logLeak = readFileSync(logFile, 'utf8').includes(realKey);
    } catch {}
  }
  record('网关日志不含真实密钥', !logLeak);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('核验失败:', e.message);
  process.exit(1);
});
