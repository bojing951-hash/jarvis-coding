/**
 * 模型代理令牌生命周期与代理拒绝路径。
 * 不依赖 Docker：代理是独立 Node 进程，用临时端口和临时密钥文件启动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-proxy-'));
process.env.HOME = tmp;
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');

const svc = await import('../src/service.mjs');

const tokenFile = join(tmp, 'proxy', 'active-tokens.json');
const readTokens = () => JSON.parse(readFileSync(tokenFile, 'utf8'));
const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function seedExecution(id, taskId) {
  svc.db()
    .prepare('INSERT INTO executions (id,task_id,status,started_at) VALUES (?,?,?,?)')
    .run(id, taskId, 'running', new Date().toISOString());
}

test('模型令牌：按 Execution 撤销，取消后其他执行令牌不受影响', () => {
  const p = svc.createProject({ name: '代理令牌', slug: 'proxy-token' });
  const t = svc.createTask({ project: p.id, title: 'token', input: 'x' });
  seedExecution('exe_a', t.id);
  seedExecution('exe_b', t.id);

  const a = svc.registerModelToken('exe_a', t.id);
  const b = svc.registerModelToken('exe_b', t.id);
  let tokens = readTokens();
  assert.equal(tokens[a].execution_id, 'exe_a');
  assert.equal(tokens[b].execution_id, 'exe_b');

  assert.equal(svc.revokeModelTokensForExecution('exe_a'), 1);
  tokens = readTokens();
  assert.equal(tokens[a], undefined);
  assert.equal(tokens[b].execution_id, 'exe_b');

  svc.revokeModelToken(b);
  assert.deepEqual(readTokens(), {});
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function startProxy(tokens) {
  const port = await freePort();
  const keyFile = join(tmp, 'glm.key');
  const tokFile = join(tmp, 'model-tokens.json');
  writeFileSync(keyFile, 'sk-test-proxy-key-not-real');
  writeFileSync(tokFile, JSON.stringify(tokens));
  const child = spawn(process.execPath, ['orchestrator/docker/egress-proxy.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROXY_PORT: String(port),
      GLM_KEY_FILE: keyFile,
      MODEL_TOKENS_FILE: tokFile,
      MODEL_UPSTREAM_HOST: '127.0.0.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy start timeout: ${stderr}`)), 8000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.includes('egress proxy on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited ${code}: ${stderr}`));
    });
  });
  await ready;
  return { port, child, stop: () => child.kill('SIGKILL') };
}

test('模型代理：无令牌/过期/已撤销 401，有效令牌才进入上游', async () => {
  const validA = 'a'.repeat(24);
  const validB = 'b'.repeat(24);
  const expired = 'c'.repeat(24);
  const proxy = await startProxy({
    [validA]: { execution_id: 'exe_a', task_id: 'tsk_a', expires_at: future() },
    [expired]: { execution_id: 'exe_c', task_id: 'tsk_c', expires_at: past() }
  });
  try {
    const base = `http://127.0.0.1:${proxy.port}/api/anthropic`;
    const noToken = await fetch(`${base}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(noToken.status, 401, '无令牌必须拒绝');

    const expiredRes = await fetch(`${base}/s/${expired}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(expiredRes.status, 401, '过期令牌必须拒绝');

    const revokedRes = await fetch(`${base}/s/${validB}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(revokedRes.status, 401, '未签发的令牌必须拒绝');

    // 有效令牌会通过授权检查，然后因为测试上游 127.0.0.1:443 不可达而返回 502。
    const validRes = await fetch(`${base}/s/${validA}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    assert.equal(validRes.status, 502, '有效令牌必须通过 401 检查');
  } finally {
    proxy.stop();
  }
});
