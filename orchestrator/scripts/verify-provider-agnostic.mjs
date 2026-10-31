#!/usr/bin/env node
/**
 * Provider 可插拔性验证（使用本地 mock，不消耗任何厂商额度）。
 *
 * 目的：证明「接入第二个 provider」只需要配置，不需要改 orchestrator 代码。
 * 注意：这是**本地 mock 服务**，不是真实厂商 API，结论不能用于声称已接入 GPT/Claude/DeepSeek。
 *
 * 运行：
 *   node orchestrator/scripts/verify-provider-agnostic.mjs
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const OPENCLAW = join(HOME, '.openclaw/bin/openclaw');
const CONFIG = join(HOME, '.openclaw/openclaw.json');
const PORT = 18999;
const MODEL_REF = 'mock/mock-1';
const AGENT = 'jv-mockcheck-echo';
const REPLY = 'MOCK_PROVIDER_OK';

const sh = (args, timeout = 120_000) =>
  new Promise((resolve) => {
    execFile(OPENCLAW, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, so, se) =>
      resolve({ code: e?.code ?? 0, out: (so || '') + (se || '') })
    );
  });

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-1',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });
});

const results = [];
const record = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' :: ' + detail : ''}`);
};

async function cleanup(backup) {
  await sh(['agents', 'delete', AGENT, '--force']).catch(() => {});
  await sh(['config', 'unset', 'models.providers.mock']).catch(() => {});
  if (backup) {
    try {
      writeFileSync(CONFIG, readFileSync(backup, 'utf8'));
      await sh(['secrets', 'reload']);
    } catch {}
  }
}

async function main() {
  const backup = join('/tmp', `openclaw.provider-check.${Date.now()}.json`);
  copyFileSync(CONFIG, backup);

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  record('mock provider 启动', true, `http://127.0.0.1:${PORT}/v1`);

  try {
    const set = await sh([
      'config', 'set', 'models.providers.mock',
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        api: 'openai-completions',
        apiKey: 'mock-key-not-a-secret',
        models: [{ id: 'mock-1', name: 'Mock Model' }]
      }),
      '--strict-json'
    ]);
    record('注册第二个 provider（仅配置）', set.code === 0, set.out.trim().split('\n').slice(-1)[0]?.slice(0, 80));

    const listed = await sh(['models', 'list', '--all', '--json']);
    record('模型出现在目录中', listed.out.includes(MODEL_REF), MODEL_REF);

    const created = await sh([
      'agents', 'add', AGENT, '--model', MODEL_REF,
      '--workspace', join(HOME, '.openclaw/projects/_provider-check/agents/echo'),
      '--non-interactive', '--json'
    ]);
    record('用新 provider 创建 Agent（代码零改动）', created.out.includes(AGENT), AGENT);

    const turn = await sh([
      'agent', '--agent', AGENT, '--session-id', 'provider-check-1',
      '--message', 'ping', '--json'
    ]);
    const ok = turn.out.includes(REPLY);
    record('真实调用返回 mock 回复', ok, ok ? REPLY : turn.out.slice(-160));
  } finally {
    await cleanup(backup);
    server.close();
    record('清理（删除 Agent、移除 provider、恢复配置）', true, backup);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  console.log('说明：这是本地 mock provider，仅证明 provider 抽象可插拔，不代表已接入真实厂商。');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
