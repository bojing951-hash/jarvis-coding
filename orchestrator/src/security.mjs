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
import { realpathSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

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
  return sha256(
    canonicalJson({
      task_id: task.id,
      project_id: task.project_id,
      executor: task.executor,
      mode: resolved.mode,
      cwd: resolved.cwd,
      verify_profile_id: resolved.verifyProfileId ?? null,
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

/* ------------------------------ 管理员入口 ---------------------------------- */

/**
 * 本地管理员密钥：只有本地 CLI 用它签发审批。
 * MCP / Agent 无法访问（Agent 没有 shell，MCP 工具里也不提供签发能力）。
 */
export function operatorKeyPath(home) {
  return `${home}/.openclaw/jarvis/operator.key`;
}

export function assertOperator(keyPath) {
  if (!keyPath || !existsSync(keyPath)) {
    throw new Error(
      `缺少管理员密钥（${keyPath}）。审批只能由本地管理员签发：先运行 jarvisctl operator init`
    );
  }
  const key = readFileSync(keyPath, 'utf8').trim();
  if (key.length < 32) throw new Error('管理员密钥无效（长度不足）');
  return true;
}

/* ------------------------------ 子进程环境 ---------------------------------- */

/** 只透传必要变量，避免把宿主密钥泄露给执行器子进程。 */
export function safeChildEnv(base = process.env) {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER'];
  const env = {};
  for (const k of keep) if (base[k] != null) env[k] = base[k];
  return env;
}
