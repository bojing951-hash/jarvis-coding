/**
 * P0-SEC-01 安全模块。
 *
 * 设计原则：
 * 1. 不可信输入（模型 / MCP / Workflow Spec / Task Input）只能选择「已登记的东西」，
 *    不能定义要执行什么。
 * 2. 所有判断都是纯函数或独立查库，不依赖调用方声明的状态。
 * 3. 无法确认时一律拒绝（fail closed）。
 */
import { createHash } from 'node:crypto';
import { realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { hostname, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { createVerify, createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';

/* ------------------------------- 参数摘要 ---------------------------------- */

/** 稳定序列化：键排序，避免同内容不同键序产生不同摘要。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 审批摘要：绑定任务的关键执行参数。
 * 任何一项变化都会导致摘要不同 → 旧审批自动失效（AC-03）。
 */
export function taskDigest(task, resolved) {
  const profile = resolved.profile ?? null;
  const verifyProfileSha = profile
    ? sha256(canonicalJson({
        program: profile.program,
        argv: profile.argv,
        cwd: profile.cwd ?? null,
        timeout_ms: profile.timeout_ms ?? null
      }))
    : null;
  return sha256(
    canonicalJson({
      task_id: task.id,
      project_id: task.project_id,
      executor: task.executor,
      mode: resolved.mode,
      cwd: resolved.cwd,
      repo: resolved.repo ?? null,
      base_commit: resolved.baseCommit ?? null,
      verify_profile_id: resolved.verifyProfileId ?? null,
      verify_profile_sha: verifyProfileSha,
      commit: Boolean(resolved.commit),
      commit_paths: [...(resolved.commitPaths ?? [])].sort(),
      input_sha: sha256(String(task.input ?? ''))
    })
  );
}

/* ---------------------------- 执行器配置校验 -------------------------------- */

/**
 * 允许出现在任务 executor_config 中的字段。
 * 刻意不包含 verified/approved/verify 等「授权类」字段——
 * 授权只能来自 approvals 表，不能来自任务参数（AC-02）。
 */
export const EXECUTOR_CONFIG_KEYS = new Set([
  'cwd',
  'repo',
  'base_commit',
  'mode',
  'verify_profile_id',
  'commit',
  'commit_paths',
  'commit_message',
  'max_turns',
  'timeout_ms'
]);

export function validateExecutorConfig(raw) {
  const errors = [];
  if (raw == null) return { ok: true, config: {}, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, config: {}, errors: ['executor_config 必须是对象'] };
  }
  const config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!EXECUTOR_CONFIG_KEYS.has(key)) {
      errors.push(`不允许的执行器字段: ${key}`);
      continue;
    }
    if (key === 'mode' && !['plan', 'acceptEdits'].includes(value)) {
      errors.push(`非法 mode: ${value}（只允许 plan / acceptEdits）`);
      continue;
    }
    if (key === 'commit_paths') {
      if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || p.startsWith('/') || p.includes('..'))) {
        errors.push('commit_paths 必须是仓库内相对路径数组');
        continue;
      }
    }
    config[key] = value;
  }
  return { ok: errors.length === 0, config, errors };
}

/* ------------------------------- 路径约束 ---------------------------------- */

/**
 * 执行目录必须落在项目真实目录内（AC-04）。
 * 用 realpath 解析，符号链接逃逸会被识破。
 */
export function resolveProjectPath(requested, projectDir) {
  if (!projectDir) return { ok: false, error: '项目目录未定义' };
  let projectReal;
  try {
    projectReal = realpathSync(projectDir);
  } catch {
    return { ok: false, error: `项目目录不可解析: ${projectDir}` };
  }

  const target = requested ? resolve(projectReal, requested) : projectReal;

  // 目标可能尚不存在：取其最近的已存在祖先再 realpath
  let probe = target;
  const suffix = [];
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..');
    if (parent === probe) break;
    suffix.unshift(probe.slice(parent.length).replace(/^\//, ''));
    probe = parent;
  }
  let probeReal;
  try {
    probeReal = realpathSync(probe);
  } catch {
    return { ok: false, error: '路径不可解析' };
  }
  const realTarget = suffix.length ? resolve(probeReal, ...suffix) : probeReal;

  const inside = realTarget === projectReal || realTarget.startsWith(projectReal + sep);
  if (!inside) {
    return { ok: false, error: `执行目录越界: ${realTarget} 不在项目 ${projectReal} 内` };
  }
  try {
    if (existsSync(realTarget) && !statSync(realTarget).isDirectory()) {
      return { ok: false, error: `目标不是目录: ${realTarget}` };
    }
  } catch {
    return { ok: false, error: '目标不可访问' };
  }
  return { ok: true, cwd: realTarget, projectReal };
}

/* -------------------------------- 提交门禁 --------------------------------- */

/**
 * 提交必须同时满足：执行成功、校验通过且已记录、授权有效、路径声明非空（AC-05）。
 */
export function commitGate({ execOk, verify, approval, commitPaths }) {
  if (!execOk) return { ok: false, reason: '执行未成功' };
  if (!verify) return { ok: false, reason: '缺少必需校验（未配置可信校验配置）' };
  if (verify.exitCode !== 0) return { ok: false, reason: `校验失败（exit ${verify.exitCode}）` };
  if (!approval?.valid) return { ok: false, reason: approval?.reason ?? '缺少有效审批' };
  if (!commitPaths?.length) return { ok: false, reason: '未声明提交范围（commit_paths 为空）' };
  return { ok: true };
}

/* ------------------------------ 执行状态机 ---------------------------------- */

export const EXEC_STATES = [
  'pending',
  'authorized',
  'running',
  'verifying',
  'committing',
  'done',
  'failed',
  'cancel_requested',
  'cancelled',
  'cancel_failed'
];

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'cancel_failed']);

export function isTerminal(state) {
  return TERMINAL.has(state);
}

/**
 * 统一裁决（DEF-01）：任务状态由完整执行链推导，
 * 不由执行器返回值单独决定。
 */
export function computeVerdict({ cancelled, execOk, verify, requiresVerify, commit, requiresCommit, approvalValid, commitRefOk }) {
  const reasons = [];
  if (cancelled) return { status: 'cancelled', reasons: ['执行被取消'] };

  if (!execOk) return { status: 'failed', reasons: ['执行器失败'] };

  if (requiresVerify) {
    if (!verify) reasons.push('缺少必需校验结果');
    else if (verify.exitCode !== 0) reasons.push(`校验失败（exit ${verify.exitCode}）`);
  }

  if (requiresCommit) {
    if (!approvalValid) reasons.push('提交阶段授权无效');
    if (!commit) reasons.push('未执行提交');
    else if (!commit.ok) reasons.push(`提交失败: ${commit.error ?? commit.reason ?? 'unknown'}`);
    else if (!commit.sha) reasons.push('提交未返回真实 SHA');
    else if (commitRefOk === false) reasons.push('提交引用发布失败，成果不可按引用取回');
  }

  return { status: reasons.length ? 'failed' : 'done', reasons };
}

/* ------------------------------ 管理员入口 ---------------------------------- */

/**
 * 本地管理员密钥：只有本地 CLI 用它签发审批。
 * MCP / Agent 无法访问（Agent 没有 shell，MCP 工具里也不提供签发能力）。
 */
export function operatorKeyPath(home) {
  return `${home}/.openclaw/jarvis/operator.key`;
}

/**
 * 可信操作者校验（DEF-04）。
 *
 * 密钥文件存在与否不能作为身份证明——同一用户下的任何进程都能读到它。
 * 改为要求真实交互式终端：Agent 没有 TTY，MCP 进程也没有。
 * 这是当前环境可验证的最强本地来源；其局限在文档中明确记录。
 */
/**
 * 调用 macOS LocalAuthentication 助手做真实用户在场认证（DEF-04）。
 * TTY 或固定字符串不再构成授权依据。
 */
export async function runMacAuth({ reason, timeoutSeconds = 60, helperPath } = {}) {
  const bin = helperPath || process.env.JARVIS_AUTH_HELPER || `${homedir()}/.openclaw/jarvis/bin/jarvis-approve`;
  if (!existsSync(bin)) {
    return { ok: false, code: 2, error: `认证助手不存在: ${bin}（未编译则拒绝高风险授权）` };
  }
  return new Promise((resolve) => {
    execFile(
      bin,
      [reason, String(timeoutSeconds)],
      { timeout: (timeoutSeconds + 10) * 1000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err?.code ?? 0;
        resolve({
          ok: code === 0,
          code: typeof code === 'number' ? code : 3,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim().slice(0, 500)
        });
      }
    );
  });
}

/* ------------------------- FIX3-A 审批签名证明 ------------------------------ */

const AUTH_DIR = `${homedir()}/.openclaw/jarvis/auth`;
export const AUTH_PUBKEY = `${AUTH_DIR}/pubkey.der`;
export const AUTH_SIGNER = process.env.JARVIS_AUTH_SIGNER || `${homedir()}/.openclaw/jarvis/bin/jarvis-auth`;

/** 审批载荷：绑定任务、参数摘要、一次性挑战与有效期。 */
export function buildApprovalPayload({ taskId, digest, nonce, expiresAt }) {
  return Buffer.from(
    canonicalJson({ task_id: taskId, digest, nonce, expires_at: expiresAt }),
    'utf8'
  );
}

export function newNonce() {
  return randomBytes(16).toString('hex');
}

/** 服务端独立验签：不信任助手退出码，只信公钥验证结果。 */
export function verifyApprovalSignature({ payload, signatureB64, pubkeyDerPath = AUTH_PUBKEY }) {
  let der;
  try {
    der = readFileSync(pubkeyDerPath);
  } catch {
    return { ok: false, error: `缺少审批公钥: ${pubkeyDerPath}` };
  }
  let pub;
  try {
    pub = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (e) {
    return { ok: false, error: `公钥不可解析: ${e.message}` };
  }
  let sig;
  try {
    sig = Buffer.from(signatureB64, 'base64');
  } catch {
    return { ok: false, error: '签名不是合法 base64' };
  }
  try {
    const ok = createVerify('sha256').update(payload).verify(pub, sig);
    return ok ? { ok: true } : { ok: false, error: '签名校验失败' };
  } catch (e) {
    return { ok: false, error: `验签异常: ${e.message}` };
  }
}

/** 调用签名器；返回签名 base64。失败即拒绝（不降级到 TTY/固定串）。 */
export async function signWithOsKey({ payload, reason, timeoutSeconds = 90 }) {
  const dir = `${homedir()}/.openclaw/jarvis/run`;
  mkdirSync(dir, { recursive: true });
  const payloadFile = `${dir}/approval-payload-${randomBytes(6).toString('hex')}.json`;
  writeFileSync(payloadFile, payload, { mode: 0o600 });
  try {
    return await new Promise((resolve) => {
      execFile(
        AUTH_SIGNER,
        ['sign', payloadFile, reason],
        { timeout: (timeoutSeconds + 10) * 1000, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return resolve({ ok: false, error: (stderr || err.message).slice(0, 300) });
          resolve({ ok: true, signature: String(stdout).trim() });
        }
      );
    });
  } finally {
    try { unlinkSync(payloadFile); } catch {}
  }
}

export function operatorIdentity() {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let user = 'unknown';
  let host = 'unknown';
  try {
    user = String(process.getuid?.() ?? 'unknown');
    host = hostname();
  } catch {}
  return {
    method: tty ? 'interactive-tty-confirmation' : 'non-interactive',
    tty,
    uid: user,
    host,
    pid: process.pid
  };
}

export function requireInteractiveOperator(confirmToken) {
  const id = operatorIdentity();
  if (!id.tty) {
    throw new Error(
      '审批必须由真实终端中的操作者完成（当前进程没有 TTY）。Agent / MCP 无法签发审批。'
    );
  }
  if (!confirmToken || confirmToken !== 'APPROVE') {
    throw new Error('必须显式确认：在终端输入 APPROVE');
  }
  return id;
}

/* ------------------------------ 子进程环境 ---------------------------------- */

/** 只透传必要变量，避免把宿主密钥泄露给执行器子进程。 */
export function safeChildEnv(base = process.env) {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER'];
  const env = {};
  for (const k of keep) if (base[k] != null) env[k] = base[k];
  return env;
}
