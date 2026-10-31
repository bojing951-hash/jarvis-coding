/**
 * 极简 HTTPS 出口代理（P0-SEC-01-FIX1）。
 *
 * 作用：执行器容器接在 --internal 网络里（无外网路由），
 * 唯一出口是本代理；本代理只允许 CONNECT 到白名单主机。
 *
 * 这不是"域名过滤假装隔离"：容器本身没有外网路由，
 * 即使直连 IP 也无法出网（见 docker network --internal）。
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';

const PORT = Number(process.env.PROXY_PORT || 8888);
const ALLOW = (process.env.ALLOW_HOSTS || 'open.bigmodel.cn')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function hostAllowed(hostport) {
  const host = String(hostport).split(':')[0].toLowerCase();
  return ALLOW.some((h) => host === h || host.endsWith(`.${h}`));
}

const server = createServer((req, res) => {
  // 只处理 CONNECT；普通 HTTP 请求一律拒绝
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('only CONNECT allowed\n');
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
  console.error(`egress proxy on :${PORT}, allow=${ALLOW.join(',')}`);
});
