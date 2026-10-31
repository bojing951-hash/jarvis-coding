/**
 * 外部执行器适配层（P1-06）。
 *
 * 首个执行器：Claude Code + 现有 GLM 配置。
 * 安全边界：
 * - 只在指定 cwd 内工作，不传 --add-dir，避免越界访问
 * - 默认 plan（只读）模式；写模式必须显式请求
 * - 不使用 bypassPermissions
 * - 记录真实 exit code / git 版本，不伪造证据
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

export function claudeBin() {
  const candidates = [
    process.env.CLAUDE_BIN,
    join(HOME, '.nvm/versions/node/v24.13.1/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return 'claude';
}

function run(cmd, args, { cwd, timeoutMs = 900_000 }) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          signaled: Boolean(err?.killed),
          stdout: stdout ?? '',
          stderr: stderr ?? ''
        });
      }
    );
  });
}

function gitHead(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 15_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/**
 * 执行一个编程任务。
 * @param {object} o
 * @param {string} o.cwd        项目工作目录（必须已存在）
 * @param {string} o.prompt     任务说明
 * @param {'plan'|'acceptEdits'} o.mode  只读 / 可写
 */
export async function runClaudeCode({ cwd, prompt, mode = 'plan', allowedTools, maxTurns, timeoutMs }) {
  if (!cwd || !existsSync(cwd)) {
    return { ok: false, error: `工作目录不存在: ${cwd}`, evidence: {} };
  }
  if (!['plan', 'acceptEdits'].includes(mode)) {
    return { ok: false, error: `不允许的执行模式: ${mode}（只支持 plan / acceptEdits）`, evidence: {} };
  }

  const headBefore = await gitHead(cwd);

  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', mode];
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (maxTurns) args.push('--max-turns', String(maxTurns));

  const started = Date.now();
  const r = await run(claudeBin(), args, { cwd, timeoutMs });
  const durationMs = Date.now() - started;

  let parsed = null;
  const start = r.stdout.indexOf('{');
  if (start >= 0) {
    try {
      parsed = JSON.parse(r.stdout.slice(start));
    } catch {
      parsed = null;
    }
  }

  const headAfter = await gitHead(cwd);
  const evidence = {
    executor: 'claude-code',
    cwd,
    mode,
    exitCode: r.code,
    durationMs,
    gitHeadBefore: headBefore,
    gitHeadAfter: headAfter,
    gitChanged: Boolean(headBefore && headAfter && headBefore !== headAfter),
    sessionId: parsed?.session_id ?? null,
    costUsd: parsed?.total_cost_usd ?? parsed?.cost_usd ?? null,
    stderr: (r.stderr || '').slice(0, 2000)
  };

  const ok = r.code === 0 && Boolean(parsed?.result ?? r.stdout);
  return {
    ok,
    text: parsed?.result ?? r.stdout.slice(0, 20_000),
    error: ok ? '' : (r.stderr || 'claude 执行失败').slice(0, 1000),
    evidence
  };
}

/** 执行器能力自检（不消耗额度）。 */
export async function executorStatus() {
  const r = await run(claudeBin(), ['--version'], { cwd: HOME, timeoutMs: 30_000 });
  return { bin: claudeBin(), version: (r.stdout || r.stderr).trim(), ok: r.code === 0 };
}
