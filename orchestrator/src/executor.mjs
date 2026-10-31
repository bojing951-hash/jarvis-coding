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
import { safeChildEnv } from './security.mjs';
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
      env: safeChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (onPid && child.pid) onPid(child.pid);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    // 超时/取消时的终止升级：SIGTERM → 等待 grace → SIGKILL
    let killSignal = null;
    const terminate = (sig) => {
      killSignal = sig;
      try { process.kill(-child.pid, sig); } catch {
        try { process.kill(child.pid, sig); } catch {}
      }
    };
    const termTimer = setTimeout(() => terminate('SIGTERM'), timeoutMs);
    const killTimer = setTimeout(() => {
      if (killSignal && child.exitCode === null) terminate('SIGKILL');
    }, timeoutMs + 5000);

    const done = (code, signal) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({
        code: code ?? 1,
        signaled: signal != null || killSignal != null,
        killSignal,
        confirmedExit: child.exitCode !== null || child.signalCode !== null,
        stdout,
        stderr
      });
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
 * 执行后校验——只接受**已登记的可信配置**，不经 Shell（AC-01）。
 * program + argv 直接交给 execFile，模型无法注入元字符。
 */
export async function runVerifyProfile({ program, argv = [], cwd, timeoutMs = 300_000 }) {
  if (!program || typeof program !== 'string') {
    return { exitCode: -1, ok: false, error: '缺少校验程序', output: '' };
  }
  // 禁止通过 shell 解释器伪装成程序
  const banned = ['sh', 'bash', 'zsh', 'dash', 'csh', 'ksh', '/bin/sh', '/bin/bash', '/bin/zsh'];
  const base = program.split('/').pop();
  if (banned.includes(program) || banned.includes(base)) {
    return { exitCode: -1, ok: false, error: `不允许以 shell 执行校验: ${program}`, output: '' };
  }
  const started = Date.now();
  const r = await new Promise((resolve) => {
    execFile(
      program,
      argv,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: safeChildEnv(), shell: false },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });
  return {
    program,
    argv,
    exitCode: r.code,
    ok: r.code === 0,
    durationMs: Date.now() - started,
    output: (r.stdout + r.stderr).slice(-4000)
  };
}

/**
 * 由编排层代为提交（不使用模型能力）。
 * 只 add 任务声明的路径，避免把无关修改一起提交（AC-05）。
 */
export async function gitCommit({ cwd, message, paths }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: '未声明提交路径' };
  }
  const git = (args) =>
    new Promise((resolve) => {
      execFile('git', ['-C', cwd, ...args], { timeout: 60_000, env: safeChildEnv() }, (e, so, se) =>
        resolve({ code: e?.code ?? 0, out: (so || '') + (se || '') })
      );
    });

  const add = await git(['add', '--', ...paths]);
  if (add.code !== 0) return { ok: false, error: add.out.slice(0, 500) };

  // 只允许提交声明的路径：暂存区出现其它文件则拒绝
  const staged = await git(['diff', '--cached', '--name-only']);
  const stagedFiles = staged.out.split('\n').map((x) => x.trim()).filter(Boolean);
  const outside = stagedFiles.filter((f) => !paths.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')));
  if (outside.length) {
    await git(['reset']);
    return { ok: false, error: `提交范围外存在改动: ${outside.join(', ')}` };
  }

  const identity = ['-c', 'user.name=JARVIS Executor', '-c', 'user.email=jarvis-executor@localhost'];
  const commit = await git([...identity, 'commit', '-m', message]);
  const head = await new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 15_000 }, (e, so) => resolve(e ? null : so.trim()));
  });
  return { ok: commit.code === 0, sha: head, files: stagedFiles, output: commit.out.slice(-1500) };
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

/* ------------------------------ 隔离工作树（DEF-07） ----------------------- */

/** 从固定 commit 创建一次性工作树；不触碰用户工作目录。 */
export async function createWorktree({ repo, commit, dest }) {
  const git = (args, cwd = repo) =>
    new Promise((resolve) => {
      execFile('git', ['-C', cwd, ...args], { timeout: 120_000, env: safeChildEnv() }, (e, so, se) =>
        resolve({ code: e?.code ?? 0, out: (so || '') + (se || '') })
      );
    });

  const exists = await git(['cat-file', '-e', `${commit}^{commit}`]);
  if (exists.code !== 0) return { ok: false, error: `commit 不存在: ${commit}` };

  const add = await git(['worktree', 'add', '--detach', dest, commit]);
  if (add.code !== 0) return { ok: false, error: add.out.slice(0, 400) };

  const head = await git(['rev-parse', 'HEAD'], dest);
  return { ok: true, path: dest, sha: head.out.trim() };
}

/** 工作树状态：初始必须干净（AC-15）。 */
export async function worktreeStatus(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain'], { timeout: 30_000 }, (e, so) =>
      resolve({ clean: (so || '').trim() === '', raw: (so || '').trim() })
    );
  });
}

/** 解析工作树改动文件（porcelain 前两列状态 + 分隔空白）。 */
export async function changedFiles(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain'], { timeout: 30_000 }, (e, so) => {
      const files = (so || '')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => l.replace(/^..\s+/, '').trim())
        .filter(Boolean);
      resolve(files);
    });
  });
}

/**
 * 把工作树里的新 commit 固定到仓库的一个 ref 上。
 * 不修改用户当前分支；detach 工作树删除后 commit 仍可达、可核对。
 */
export async function publishRef({ repo, ref, sha }) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'update-ref', ref, sha], { timeout: 30_000 }, (e, so, se) =>
      resolve({ ok: !e, ref, sha, out: (so || '') + (se || '') })
    );
  });
}

/** 读取引用指向的 SHA（用于确认发布是否真的可用）。 */
export async function revParseRef({ repo, ref }) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'rev-parse', ref], { timeout: 20_000 }, (e, so) => resolve(e ? null : so.trim()));
  });
}

export async function removeWorktree({ repo, dest }) {
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
