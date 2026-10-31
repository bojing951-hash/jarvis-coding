/**
 * OpenClaw 适配层：只调用官方 CLI，不重写会话引擎。
 *
 * 所有"聊天"能力都复用 OpenClaw 的 agent / session 机制；
 * 本层只负责参数拼装、JSON 解析与错误归一化。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

export function openclawBin() {
  const candidates = [
    process.env.OPENCLAW_BIN,
    join(HOME, '.openclaw/bin/openclaw'),
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw'
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return 'openclaw';
}

function run(args, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    execFile(
      openclawBin(),
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: `${join(HOME, '.openclaw/bin')}:${process.env.PATH}` }
      },
      (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          killed: Boolean(err?.killed),
          stdout: stdout ?? '',
          stderr: stderr ?? ''
        });
      }
    );
  });
}

/** OpenClaw 的 --json 会在 JSON 后追加状态行，需容错解析。 */
export function parseJsonLoose(raw) {
  if (!raw) return null;
  // 顶层可能是对象或数组，取最先出现的那个
  const objAt = raw.indexOf('{');
  const arrAt = raw.indexOf('[');
  let start;
  if (objAt < 0) start = arrAt;
  else if (arrAt < 0) start = objAt;
  else start = Math.min(objAt, arrAt);
  if (start < 0) return null;
  try {
    return new JSONDecoderShim().decode(raw.slice(start));
  } catch {
    return null;
  }
}

class JSONDecoderShim {
  decode(s) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return JSON.parse(s.slice(0, i + 1));
      }
    }
    throw new Error('unterminated json');
  }
}

export async function listModels(provider) {
  const args = ['models', 'list', '--json'];
  if (provider) args.push('--provider', provider);
  const r = await run(args, 60_000);
  const data = parseJsonLoose(r.stdout);
  if (!data) return [];
  const rows = Array.isArray(data) ? data : data.models ?? [];
  return rows.map((m) => {
    const ref = m.key ?? m.ref ?? (m.provider ? `${m.provider}/${m.id}` : m.id) ?? '';
    const [prov, ...rest] = String(ref).split('/');
    return {
      ref,
      id: m.id ?? (rest.length ? rest.join('/') : ref),
      provider: m.provider ?? (rest.length ? prov : ''),
      name: m.name ?? '',
      available: m.available !== false,
      tags: m.tags ?? []
    };
  });
}

/** 只允许已注册的模型，避免出现 "Unknown model" 的运行时失败。 */
export async function assertModelUsable(modelRef) {
  const models = await listModels();
  const ok = models.some((m) => m.ref === modelRef || m.id === modelRef);
  if (!ok) {
    const err = new Error(`模型不可用: ${modelRef}。先用 openclaw models list --all 确认，必要时在 models.providers.<id>.models 中声明。`);
    err.code = 'MODEL_UNKNOWN';
    throw err;
  }
  return true;
}

export async function createAgent({ name, model, workspace }) {
  const r = await run([
    'agents', 'add', name,
    '--model', model,
    '--workspace', workspace,
    '--non-interactive',
    '--json'
  ]);
  const data = parseJsonLoose(r.stdout);
  if (!data?.agentId) {
    throw new Error(`创建 agent 失败: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  return data;
}


/** 复用时同步 agent 的模型与工作区（OpenClaw 把它们存在 agents.entries.<id>）。 */
export async function configureAgent(agentId, { model, workspace }) {
  if (model) await run(['config', 'set', `agents.entries.${agentId}.model`, model], 60_000);
  if (workspace) await run(['config', 'set', `agents.entries.${agentId}.workspace`, workspace], 60_000);
}

export async function deleteAgent(name) {
  return run(['agents', 'delete', name, '--force'], 120_000);
}

export async function listAgents() {
  const r = await run(['agents', 'list', '--json'], 60_000);
  const data = parseJsonLoose(r.stdout);
  return data?.agents ?? (Array.isArray(data) ? data : []);
}

export async function listSessions(agentId) {
  const r = await run(['sessions', '--agent', agentId, '--json', '--limit', 'all'], 60_000);
  const data = parseJsonLoose(r.stdout);
  return data?.sessions ?? (Array.isArray(data) ? data : []);
}

/**
 * 执行一轮对话。复用 OpenClaw 原生 session；
 * sessionKey 相同则续接上下文，不同则完全隔离。
 */
export async function ask({ agentId, sessionKey, message, model, timeoutMs }) {
  const args = ['agent', '--agent', agentId, '--session-id', sessionKey, '--message', message, '--json'];
  if (model) args.push('--model', model);
  const r = await run(args, timeoutMs ?? 300_000);
  const data = parseJsonLoose(r.stdout);
  if (!data) {
    return { ok: false, text: '', error: (r.stderr || r.stdout || '无输出').slice(0, 500) };
  }
  if (data.status !== 'ok') {
    return { ok: false, text: '', error: (data.error?.message || 'unknown error').slice(0, 500) };
  }
  const res = data.result ?? {};
  const meta = res.meta?.agentMeta ?? {};
  return {
    ok: true,
    text: res.payloads?.[0]?.text ?? '',
    model: meta.model ?? model ?? '',
    provider: meta.provider ?? '',
    sessionId: meta.sessionId ?? sessionKey,
    usage: meta.usage ?? null,
    error: ''
  };
}

export async function gatewayStatus() {
  const r = await run(['gateway', 'status'], 60_000);
  return r.stdout;
}
