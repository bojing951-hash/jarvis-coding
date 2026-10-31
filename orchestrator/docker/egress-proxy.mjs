/**
 * 受控出口代理（FIX2 / RISK-01）。
 *
 * 两种职责：
 * 1) HTTPS CONNECT 隧道：仅允许白名单主机（默认 open.bigmodel.cn）。
 * 2) 模型请求代理：容器不持有 API Key，把 ANTHROPIC_BASE_URL 指向本代理，
 *    由代理在宿主侧注入 Authorization 头。
 *
 * 这样即使容器内的代码（含测试进程、Claude Code 子进程）被完全控制，
 * 也拿不到长期密钥；密钥只存在于宿主代理进程与只读密钥文件里。
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PROXY_PORT || 8888);
const ALLOW = (process.env.ALLOW_HOSTS || 'open.bigmodel.cn')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MODEL_PREFIX = process.env.MODEL_PROXY_PREFIX || '/api/anthropic';
const UPSTREAM_HOST = process.env.MODEL_UPSTREAM_HOST || 'open.bigmodel.cn';
const KEY_FILE = process.env.GLM_KEY_FILE || '/run/secrets/glm.key';

function loadKey() {
  try {
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    if (raw.startsWith('sk-') || raw.length > 20) return raw;
    // 允许 KEY=VALUE 形式
    const m = raw.match(/=[ \t]*(.+)$/);
    return m ? m[1].trim() : raw;
  } catch {
    return null;
  }
}

const API_KEY = loadKey();
if (!API_KEY) {
  console.error(`[fatal] 无法读取模型密钥文件: ${KEY_FILE}`);
  process.exit(1);
}

function hostAllowed(hostport) {
  const host = String(hostport).split(':')[0].toLowerCase();
  return ALLOW.some((h) => host === h || host.endsWith(`.${h}`));
}

const server = createServer((req, res) => {
  if (!req.url.startsWith(MODEL_PREFIX)) {
    console.error(`[deny-http] ${req.method} ${req.url}`);
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden path\n');
    return;
  }

  const upstreamPath = req.url; // 保留 /api/anthropic/... 前缀
  const headers = { ...req.headers };
  delete headers.host;
  headers.host = UPSTREAM_HOST;
  headers.authorization = `Bearer ${API_KEY}`;

  const upstream = httpsRequest(
    { host: UPSTREAM_HOST, port: 443, path: upstreamPath, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (e) => {
    console.error(`[upstream-error] ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream error\n');
    }
  });
  req.pipe(upstream);
  console.error(`[model] ${req.method} ${upstreamPath}`);
});

server.on('connect', (req, clientSocket, head) => {
  const target = req.url;
  if (!hostAllowed(target)) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    console.error(`[deny] ${target}`);
    return;
  }
  const [host, port = 443] = target.split(':');
  const upstream = connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    console.error(`[allow] ${target}`);
  });
  upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.error(`egress proxy on :${PORT}, allow=${ALLOW.join(',')}, model=${MODEL_PREFIX} -> ${UPSTREAM_HOST}`);
});
