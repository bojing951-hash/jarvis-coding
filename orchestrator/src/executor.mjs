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
import { execFile, spawn } from 'node:child_process';
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

/**
 * 独立进程组运行，便于整体取消（kill 负 pid）。
 * onPid 回调用于把 pid 落盘，供外部 cancel 使用。
 */
function run(cmd, args, { cwd, timeoutMs = 900_000, onPid }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (onPid && child.pid) onPid(child.pid);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }, timeoutMs);

    const done = (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signaled: signal != null, stdout, stderr });
    };
    child.on('close', done);
    child.on('error', (e) => done(1, null));
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
export async function runClaudeCode({ cwd, prompt, mode = 'plan', allowedTools, maxTurns, timeoutMs, onPid }) {
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
  const r = await run(claudeBin(), args, { cwd, timeoutMs, onPid });
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

  // SIGTERM 可能以 143 退出而非 signal 字段，两者都算取消
  const cancelled = r.signaled === true || r.code === 143 || r.code === 130;
  const ok = !cancelled && r.code === 0 && Boolean(parsed?.result ?? r.stdout);
  return {
    ok,
    cancelled,
    text: parsed?.result ?? r.stdout.slice(0, 20_000),
    error: cancelled ? '执行被取消' : ok ? '' : (r.stderr || 'claude 执行失败').slice(0, 1000),
    evidence: { ...evidence, cancelled }
  };
}

/**
 * 执行后校验：由编排层执行**运维指定**的命令（不是模型指定），
 * 因此不需要给 Claude 放开 Shell 权限。
 */
export async function runVerify({ cwd, command, timeoutMs = 300_000 }) {
  if (!command) return null;
  const started = Date.now();
  // 固定用 /bin/sh -c，命令来自 operator 配置而非模型输出
  const r = await new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
  return {
    command,
    exitCode: r.code,
    ok: r.code === 0,
    durationMs: Date.now() - started,
    output: (r.stdout + r.stderr).slice(-4000)
  };
}

/**
 * 由编排层代为提交（不使用模型能力，避免给 Claude 开 git 权限）。
 * 用 -c 传入身份，不修改用户的全局 git 配置。
 */
export async function gitCommit({ cwd, message }) {
  const identity = [
    '-c', 'user.name=JARVIS Executor',
    '-c', 'user.email=jarvis-executor@localhost'
  ];
  const add = await new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'add', '-A'], { timeout: 60_000 }, (e, so, se) => resolve({ code: e?.code ?? 0, out: so + se }));
  });
  if (add.code !== 0) return { ok: false, error: add.out.slice(0, 500) };

  const commit = await new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...identity, 'commit', '-m', message], { timeout: 60_000 }, (e, so, se) => resolve({ code: e?.code ?? 0, out: so + se }));
  });

  const head = await new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 15_000 }, (e, so) => resolve(e ? null : so.trim()));
  });
  return { ok: commit.code === 0, sha: head, output: commit.out.slice(-1500) };
}

/**
 * 在指定 commit 上创建只读工作树快照。
 * 审计必须针对固定版本，而不是浮动的 HEAD。
 */
export async function createFrozenWorktree({ repo, commit, dest }) {
  const runGit = (args) =>
    new Promise((resolve) => {
      execFile('git', ['-C', repo, ...args], { timeout: 120_000 }, (e, so, se) =>
        resolve({ code: e?.code ?? 0, out: (so || '') + (se || '') })
      );
    });

  const verify = await runGit(['cat-file', '-e', `${commit}^{commit}`]);
  if (verify.code !== 0) return { ok: false, error: `commit 不存在: ${commit}` };

  const add = await runGit(['worktree', 'add', '--detach', dest, commit]);
  if (add.code !== 0) return { ok: false, error: add.out.slice(0, 400) };

  const head = await new Promise((resolve) => {
    execFile('git', ['-C', dest, 'rev-parse', 'HEAD'], { timeout: 15_000 }, (e, so) => resolve(e ? null : so.trim()));
  });
  return { ok: true, path: dest, sha: head };
}

export async function removeFrozenWorktree({ repo, dest }) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'worktree', 'remove', '--force', dest], { timeout: 60_000 }, (e, so, se) =>
      resolve({ ok: !e, out: (so || '') + (se || '') })
    );
  });
}

/** 执行器能力自检（不消耗额度）。 */
export async function executorStatus() {
  const r = await run(claudeBin(), ['--version'], { cwd: HOME, timeoutMs: 30_000 });
  return { bin: claudeBin(), version: (r.stdout || r.stderr).trim(), ok: r.code === 0 };
}
