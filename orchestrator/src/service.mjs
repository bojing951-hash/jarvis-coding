/**
 * 调度服务层：Project / Agent / Conversation / Task / Execution 的真实操作。
 * CLI 与 MCP 共用这一层，保证两条入口行为一致。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase, now, newId, slugify } from './db.mjs';
import * as oc from './oc.mjs';
import * as ex from './executor.mjs';
import { validateExecutorConfig, resolveProjectPath, taskDigest, commitGate, canonicalJson, sha256, computeVerdict, operatorIdentity } from './security.mjs';
import * as iso from './isolation.mjs';

const HOME = homedir();
export const JARVIS_HOME = process.env.JARVIS_HOME || join(HOME, '.openclaw', 'jarvis');
export const PROJECTS_ROOT = join(HOME, '.openclaw', 'projects');
export const DB_PATH = process.env.JARVIS_DB || join(JARVIS_HOME, 'state.db');

let _db;
export function db() {
  if (!_db) {
    mkdirSync(JARVIS_HOME, { recursive: true });
    _db = openDatabase(DB_PATH);
  }
  return _db;
}

const event = (kind, projectId, payload) => {
  db()
    .prepare('INSERT INTO events (id, project_id, kind, payload, created_at) VALUES (?,?,?,?,?)')
    .run(newId('ev'), projectId ?? null, kind, JSON.stringify(payload ?? {}), now());
};

/* ---------------------------------- Projects --------------------------------- */

export function createProject({ name, slug }) {
  const s = slug ? slugify(slug) : slugify(name);
  const existing = db().prepare('SELECT * FROM projects WHERE slug = ?').get(s);
  if (existing) throw new Error(`项目 slug 已存在: ${s}`);
  const id = newId('prj');
  const dir = join(PROJECTS_ROOT, s);
  mkdirSync(dir, { recursive: true });
  const t = now();
  db()
    .prepare('INSERT INTO projects (id,name,slug,dir,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, name, s, dir, 'active', t, t);
  event('project.created', id, { name, slug: s });
  return getProject(id);
}

export function listProjects() {
  return db().prepare('SELECT * FROM projects ORDER BY created_at').all();
}

export function getProject(ref) {
  const row = db()
    .prepare('SELECT * FROM projects WHERE id = ? OR slug = ? OR name = ?')
    .get(ref, ref, ref);
  if (!row) throw new Error(`项目不存在: ${ref}`);
  return row;
}

export function setProjectStatus(ref, status) {
  const p = getProject(ref);
  db().prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), p.id);
  event(`project.${status}`, p.id, {});
  return getProject(p.id);
}

/* ----------------------------------- Agents ---------------------------------- */

export async function createAgent({ project: projectRef, name, model, role, roleFile }) {
  const project = getProject(projectRef);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
    throw new Error('agent 名称只能是 2-41 位小写字母/数字/连字符');
  }
  if (!model) throw new Error('必须指定 --model（例如 zai/glm-4.6），模型与角色解耦');

  await oc.assertModelUsable(model);

  const workspace = join(project.dir, 'agents', name);
  mkdirSync(workspace, { recursive: true });

  let rolePrompt = role ?? '';
  if (roleFile) {
    if (!existsSync(roleFile)) throw new Error(`角色文件不存在: ${roleFile}`);
    rolePrompt = readFileSync(roleFile, 'utf8');
  }
  if (rolePrompt) writeFileSync(join(workspace, 'ROLE.md'), rolePrompt);

  // OpenClaw agent 使用全局唯一 id，避免跨项目冲突
  const openclawAgentId = `jv-${project.slug}-${name}`;
  let created;
  try {
    created = await oc.createAgent({ name: openclawAgentId, model, workspace });
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
    // 幂等：复用已有 OpenClaw agent，并把模型/工作区同步到期望值
    await oc.configureAgent(openclawAgentId, { model, workspace });
    created = { agentId: openclawAgentId, reused: true };
  }

  const id = newId('agt');
  const t = now();
  db()
    .prepare(`INSERT INTO agents (id,project_id,name,model,role_prompt,workspace,openclaw_agent_id,status,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project.id, name, model, rolePrompt, workspace, created.agentId ?? openclawAgentId, 'active', t, t);
  event('agent.created', project.id, { name, model });
  return getAgent(id);
}

export function listAgents(projectRef) {
  if (!projectRef) return db().prepare('SELECT * FROM agents ORDER BY created_at').all();
  const p = getProject(projectRef);
  return db().prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at').all(p.id);
}

/**
 * 解析 Agent 引用。支持三种写法：
 *   - agt_xxx               唯一 id
 *   - <项目slug>/<名称>      推荐：跨项目同名时无歧义
 *   - <名称>                 仅当全局唯一时允许
 */
export function getAgent(ref, projectRef) {
  const value = String(ref);
  if (value.includes('/')) {
    const [projSlug, agentName] = value.split('/');
    const p = getProject(projSlug);
    const row = db().prepare('SELECT * FROM agents WHERE project_id = ? AND name = ?').get(p.id, agentName);
    if (!row) throw new Error(`项目 ${projSlug} 中不存在 Agent: ${agentName}`);
    return row;
  }

  const byId = db().prepare('SELECT * FROM agents WHERE id = ?').get(value);
  if (byId) return byId;

  let rows = db().prepare('SELECT * FROM agents WHERE name = ? OR openclaw_agent_id = ?').all(value, value);
  if (projectRef) {
    const p = getProject(projectRef);
    rows = rows.filter((r) => r.project_id === p.id);
  }
  if (rows.length === 0) throw new Error(`Agent 不存在: ${value}`);
  if (rows.length > 1) {
    const hints = rows.map((r) => {
      const p = db().prepare('SELECT slug FROM projects WHERE id = ?').get(r.project_id);
      return `${p?.slug ?? r.project_id}/${r.name}`;
    });
    throw new Error(
      `Agent 名称有歧义: ${value}（命中 ${rows.length} 个：${hints.join('、')}）。请用「项目slug/名称」指定。`
    );
  }
  return rows[0];
}

export function setAgentRole(ref, role) {
  const a = getAgent(ref);
  db().prepare('UPDATE agents SET role_prompt = ?, updated_at = ? WHERE id = ?').run(role, now(), a.id);
  writeFileSync(join(a.workspace, 'ROLE.md'), role);
  event('agent.role_updated', a.project_id, { agent: a.name });
  return getAgent(a.id);
}

export function setAgentModel(ref, model) {
  const a = getAgent(ref);
  db().prepare('UPDATE agents SET model = ?, updated_at = ? WHERE id = ?').run(model, now(), a.id);
  event('agent.model_updated', a.project_id, { agent: a.name, model });
  return getAgent(a.id);
}

export function setAgentStatus(ref, status) {
  const a = getAgent(ref);
  db().prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), a.id);
  return getAgent(a.id);
}

/* -------------------------------- Conversations ------------------------------- */

export function createConversation({ agent: agentRef, title }) {
  const a = getAgent(agentRef);
  const id = newId('cnv');
  const sessionKey = `${a.openclaw_agent_id}:${id}`;
  const t = now();
  db()
    .prepare('INSERT INTO conversations (id,agent_id,session_key,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, a.id, sessionKey, title ?? '', t, t);
  event('conversation.created', a.project_id, { agent: a.name, title });
  return getConversation(id);
}

export function getConversation(ref) {
  const row = db()
    .prepare('SELECT * FROM conversations WHERE id = ? OR session_key = ?')
    .get(ref, ref);
  if (!row) throw new Error(`会话不存在: ${ref}`);
  return row;
}

export function listConversations(agentRef) {
  const a = getAgent(agentRef);
  return db().prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at').all(a.id);
}

/* ---------------------------------- Talking ---------------------------------- */

/**
 * 与指定 Agent 对话。会话隔离由 OpenClaw session 保证：
 * 同一 sessionKey 续接上下文，不同 sessionKey 完全隔离。
 */
export async function talk({ agent: agentRef, message, conversation: convRef, sessionKey, project: projectRef }) {
  const a = getAgent(agentRef, projectRef);
  const project = getProject(a.project_id);
  if (project.status === 'paused') {
    return { ok: false, blocked: 'project_paused', error: `项目 ${project.slug} 已暂停，不执行新对话` };
  }
  if (a.status !== 'active') {
    return { ok: false, blocked: 'agent_inactive', error: `Agent ${a.name} 状态为 ${a.status}` };
  }

  let key = sessionKey;
  if (convRef) key = getConversation(convRef).session_key;
  if (!key) {
    const conv = createConversation({ agent: a.id });
    key = conv.session_key;
  }

  const started = now();
  const execId = newId('exe');
  db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, null, a.id, 'running', a.model, key, started);

  const res = await oc.ask({ agentId: a.openclaw_agent_id, sessionKey: key, message });
  finishExecution(execId, res);
  return { ...res, sessionKey: key, agent: a.name, model: res.model || a.model };
}

function finishExecution(execId, res) {
  db()
    .prepare('UPDATE executions SET status=?, model=?, output=?, error=?, evidence=?, finished_at=? WHERE id=?')
    .run(
      res.ok ? 'ok' : 'failed',
      res.model ?? '',
      res.text ?? '',
      res.ok ? '' : res.error ?? '',
      JSON.stringify({ usage: res.usage ?? null }),
      now(),
      execId
    );
}

/* ----------------------------------- Tasks ----------------------------------- */

export function createTask({ project: projectRef, title, input, assignee, kind, needsApproval, maxAttempts, parentTaskId, workflowId, executor, executorConfig }) {
  const project = getProject(projectRef);
  // 在项目范围内解析，避免跨项目同名 Agent 歧义
  const a = assignee ? getAgent(assignee, project.id) : null;
  if (a && a.project_id !== project.id) throw new Error('Agent 不属于该项目，禁止跨项目直接指派');
  const id = newId('tsk');
  const t = now();
  db()
    .prepare(`INSERT INTO tasks (id,project_id,workflow_id,parent_task_id,title,kind,status,assignee_agent_id,input,max_attempts,needs_approval,executor,executor_config,verify_profile_id,commit_paths,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project.id, workflowId ?? null, parentTaskId ?? null, title, kind ?? 'agent_turn', 'pending',
         a?.id ?? null, input ?? '', maxAttempts ?? 3, needsApproval ? 1 : 0,
         executor ?? 'agent', JSON.stringify(executorConfig ?? {}),
         executorConfig?.verify_profile_id ?? null,
         JSON.stringify(executorConfig?.commit_paths ?? []), t, t);
  event('task.created', project.id, { title, assignee: a?.name ?? null });
  return getTask(id);
}

export function getTask(ref) {
  const row = db().prepare('SELECT * FROM tasks WHERE id = ?').get(ref);
  if (!row) throw new Error(`任务不存在: ${ref}`);
  return row;
}

export function listTasks(projectRef, status) {
  if (projectRef) {
    const p = getProject(projectRef);
    return status
      ? db().prepare('SELECT * FROM tasks WHERE project_id=? AND status=? ORDER BY created_at').all(p.id, status)
      : db().prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at').all(p.id);
  }
  return db().prepare('SELECT * FROM tasks ORDER BY created_at').all();
}

export function updateTask(ref, patch) {
  const t = getTask(ref);
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  fields.push('updated_at = ?');
  values.push(now(), t.id);
  db().prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTask(t.id);
}

/** 显式重试：终态任务必须经此入口回到可执行状态（DEF-08）。 */
export function retryTask(ref) {
  const t = getTask(ref);
  if (!['failed', 'cancelled', 'cancel_failed'].includes(t.status)) {
    throw new Error(`只有 failed/cancelled/cancel_failed 状态可以重试，当前 ${t.status}`);
  }
  db()
    .prepare("UPDATE tasks SET status='retry_pending', error='', updated_at=? WHERE id=? AND status IN ('failed','cancelled','cancel_failed')")
    .run(now(), t.id);
  event('task.retry_requested', t.project_id, { title: t.title });
  return getTask(t.id);
}

export function approveTask(ref) {
  const t = getTask(ref);
  db().prepare('UPDATE tasks SET approved_at=?, status=?, updated_at=? WHERE id=?')
    .run(now(), 'approved', now(), t.id);
  event('task.approved', t.project_id, { title: t.title });
  return getTask(t.id);
}

/**
 * 执行任务：调用被指派 Agent，记录执行证据。
 * 不吞错误、不伪造结果。
 */
export async function runTask(ref) {
  const task = getTask(ref);
  const project = getProject(task.project_id);
  if (project.status === 'paused') {
    return { ok: false, blocked: 'project_paused', error: '项目已暂停' };
  }
  // DEF-08：终态保护，先于一切重试/审批判断；终态不可被重复调用改变
  if (['done', 'cancelled', 'cancel_failed'].includes(task.status)) {
    return { ok: false, blocked: 'terminal_state', error: `任务已处于终态 ${task.status}，不允许重复执行` };
  }
  // DEF-05：旧 approved_at 只约束普通 Agent 任务；
  // 执行器/审计任务只认新的 approvals 记录，不被旧字段阻断，也不被其放行
  const highRisk = task.kind === 'executor' || task.kind === 'audit';
  if (!highRisk && task.needs_approval && !task.approved_at) {
    return { ok: false, blocked: 'needs_approval', error: '该任务需要人工审批后才能执行' };
  }
  if (task.attempts >= task.max_attempts) {
    db()
      .prepare("UPDATE tasks SET status='failed', error='超过最大重试次数', updated_at=? WHERE id=? AND status NOT IN ('done','cancelled','cancel_failed')")
      .run(now(), task.id);
    return { ok: false, blocked: 'max_attempts', error: '超过最大重试次数' };
  }
  if (task.kind === 'executor') {
    return runExecutorTask(task, project);
  }
  if (task.kind === 'audit') {
    return runAuditTask(task, project);
  }
  if (!task.assignee_agent_id) {
    return { ok: false, blocked: 'no_assignee', error: '任务未指派 Agent' };
  }

  const agent = getAgent(task.assignee_agent_id);
  const claim = db()
    .prepare("UPDATE tasks SET status='running', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('pending','approved','retry_pending')")
    .run(now(), task.id);
  if (claim.changes !== 1) {
    return { ok: false, blocked: 'already_running', error: '任务已在运行或状态不允许执行' };
  }

  const execId = newId('exe');
  const started = now();
  const sessionKey = `${agent.openclaw_agent_id}:task:${task.id}`;
  db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, task.id, agent.id, 'running', agent.model, sessionKey, started);

  const res = await oc.ask({ agentId: agent.openclaw_agent_id, sessionKey, message: task.input });
  finishExecution(execId, res);

  if (res.ok) {
    updateTask(task.id, { status: 'done', output: res.text, error: '' });
  } else {
    const willRetry = task.attempts + 1 < task.max_attempts;
    updateTask(task.id, { status: willRetry ? 'retry_pending' : 'failed', error: res.error ?? '' });
  }
  return { ...res, task: getTask(task.id), execution: execId };
}

/**
 * 跨 Agent 任务交接（P1-03）。
 * 只传递任务相关内容，不复制来源会话全量历史。
 */
export async function handoff({ project: projectRef, from, to, title, requirement, artifact, context, constraints }) {
  const project = getProject(projectRef);
  const src = getAgent(from, project.id);
  const dst = getAgent(to, project.id);
  if (src.project_id !== project.id || dst.project_id !== project.id) {
    throw new Error('交接双方必须属于同一项目');
  }

  const input = [
    `# 任务交接`,
    ``,
    `- 来源 Agent: ${src.name}（模型 ${src.model}）`,
    `- 目标 Agent: ${dst.name}（模型 ${dst.model}）`,
    `- 项目: ${project.name} (${project.slug})`,
    ``,
    `## 原始要求`,
    requirement || '（未填写）',
    ``,
    `## 需要处理的成果`,
    artifact || '（未提供成果）',
    ``,
    context ? `## 必要上下文\n${context}\n` : '',
    constraints ? `## 限制条件\n${constraints}\n` : '',
    `## 输出要求`,
    `基于以上成果完成你的职责，明确给出结论与依据。不要臆造未提供的事实。`
  ]
    .filter(Boolean)
    .join('\n');

  const task = createTask({
    project: project.id,
    title: title || `交接: ${src.name} → ${dst.name}`,
    input,
    assignee: dst.id
  });

  const result = await runTask(task.id);
  return {
    ...result,
    handoff: { from: src.name, to: dst.name, taskId: task.id },
    task: getTask(task.id)
  };
}

/**
 * 外部执行器任务：调用 Claude Code，记录真实证据。
 * 与聊天 Agent 的权限完全分离——执行器不是 Agent，Agent 也拿不到 Shell。
 */
/**
 * 解析执行计划：把不可信配置转成受约束的计划。
 * 任何一项不合法都返回 blocked，不做"尽力而为"。
 */
export function resolveExecutorPlan(task, project) {
  const parsed = JSON.parse(task.executor_config || '{}');
  const v = validateExecutorConfig(parsed);
  if (!v.ok) return { ok: false, blocked: 'invalid_executor_config', error: v.errors.join('; ') };
  const cfg = v.config;

  const pathCheck = resolveProjectPath(cfg.cwd, project.dir);
  if (!pathCheck.ok) return { ok: false, blocked: 'path_outside_project', error: pathCheck.error };

  const mode = cfg.mode ?? 'plan';
  const commit = Boolean(cfg.commit);
  const commitPaths = cfg.commit_paths ?? [];
  const verifyProfileId = task.verify_profile_id ?? cfg.verify_profile_id ?? null;

  let profile = null;
  if (verifyProfileId) {
    profile = db().prepare('SELECT * FROM verify_profiles WHERE id = ?').get(verifyProfileId);
    if (!profile) return { ok: false, blocked: 'unknown_verify_profile', error: `校验配置不存在: ${verifyProfileId}` };
    if (profile.project_id !== project.id) {
      return { ok: false, blocked: 'verify_profile_cross_project', error: '校验配置不属于该项目' };
    }
  }

  let repoPath = null;
  if (cfg.repo) {
    const rc = resolveProjectPath(cfg.repo, project.dir);
    if (!rc.ok) return { ok: false, blocked: 'repo_outside_project', error: rc.error };
    repoPath = rc.cwd;
  }

  const resolved = {
    mode,
    cwd: pathCheck.cwd,
    verifyProfileId,
    commit,
    commitPaths,
    profile,
    repo: repoPath,
    baseCommit: cfg.base_commit ?? null
  };
  resolved.digest = taskDigest(task, resolved);
  return { ok: true, resolved };
}

/** 当前有效的审批记录（摘要必须完全匹配，过期/撤销/已用都算无效）。 */
export function findValidApproval(taskId, digest) {
  const row = db()
    .prepare(`SELECT * FROM approvals
              WHERE task_id = ? AND digest = ? AND revoked_at IS NULL AND used_at IS NULL
              ORDER BY issued_at DESC LIMIT 1`)
    .get(taskId, digest);
  if (!row) return { valid: false, reason: '没有与该任务参数匹配的审批记录' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: '审批已过期' };
  }
  return { valid: true, approval: row };
}

/**
 * 签发审批——只能由本地管理员入口调用（CLI）。
 * MCP 不暴露此能力（AC-02）。
 */
/**
 * 审批预览：把「正在批准什么」变成可读文本，作为系统认证弹窗的理由（DEF-04）。
 */
export function approvalPreview(taskRef) {
  const task = getTask(taskRef);
  const project = getProject(task.project_id);
  const plan = resolveExecutorPlan(task, project);
  if (!plan.ok) {
    const err = new Error(`${plan.blocked}: ${plan.error}`);
    err.blocked = plan.blocked;
    throw err;
  }
  const r = plan.resolved;
  const scope = {
    project: project.slug,
    executor: task.executor,
    mode: r.mode,
    cwd: r.cwd,
    repo: r.repo,
    base_commit: r.baseCommit,
    verify_profile: r.verifyProfileId,
    commit: r.commit,
    commit_paths: r.commitPaths
  };
  const reason = [
    `JARVIS 高风险授权：${task.title}`,
    `任务 ${task.id} / 项目 ${project.slug}`,
    `执行器 ${task.executor} / 模式 ${r.mode}`,
    `目录 ${r.cwd}`,
    r.commit ? `提交范围 ${r.commitPaths.join(', ')}` : '不允许提交',
    `参数摘要 ${r.digest.slice(0, 16)}`
  ].join('\n');
  return { task_id: task.id, digest: r.digest, reason, scope };
}

export function issueApproval({ task: taskRef, ttlHours = 24, issuedBy = 'local-operator', auth = null }) {
  const task = getTask(taskRef);
  const project = getProject(task.project_id);
  const plan = resolveExecutorPlan(task, project);
  if (!plan.ok) return { ok: false, error: `${plan.blocked}: ${plan.error}` };
  const { resolved } = plan;

  const id = newId('apv');
  const issued = now();
  const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  const operator = operatorIdentity();
  const scope = {
    _operator: { method: operator.method, uid: operator.uid, host: operator.host },
    _auth: auth ? { method: 'macos-localauth', code: auth.code } : null,
    project: project.slug,
    executor: task.executor,
    mode: resolved.mode,
    cwd: resolved.cwd,
    verify_profile: resolved.verifyProfileId,
    commit: resolved.commit,
    commit_paths: resolved.commitPaths
  };
  db()
    .prepare('INSERT INTO approvals (id,task_id,digest,scope,issued_by,issued_at,expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, task.id, resolved.digest, JSON.stringify(scope), issuedBy, issued, expires);
  event('approval.issued', project.id, { task: task.id, scope });
  return { ok: true, approval: { id, task: task.id, digest: resolved.digest, scope, expires_at: expires } };
}

export function listApprovals(taskRef) {
  const task = getTask(taskRef);
  return db().prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY issued_at DESC').all(task.id);
}

/**
 * 外部执行器任务。
 *
 * 阶段：授权 → 执行 → 校验 → 提交前检查 → Commit → 记录
 * 取消后不得再进入后续副作用阶段（AC-06）。
 */
/** 记录一次尝试（包括执行器尚未启动就被拒绝的情况）。AC-21 */
function recordAttempt({ task, project, phase, status, blocked, reason, plan }) {
  const id = newId('exe');
  db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at,finished_at,error,evidence) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(
      id,
      task.id,
      null,
      status,
      'claude-code-isolated',
      plan?.cwd ?? '',
      now(),
      status === 'running' ? null : now(),
      blocked ? `${blocked}: ${reason}` : '',
      JSON.stringify({ phase, blocked: blocked ?? null, reason: reason ?? null, plan: plan ?? null })
    );
  event(`execution.${status}`, project.id, { task: task.id, execution: id, phase, blocked, reason });
  return id;
}

/**
 * 运行时凭据文件：只读挂载进容器，入口脚本 source 后并删除。
 * 不写入镜像，也不通过 docker run -e 传递（避免出现在 docker inspect）。
 */
function writeCredentialFile(execId, proxyUrl) {
  const settingsPath = join(HOME, '.claude/settings.json');
  let env = {};
  try {
    env = JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? {};
  } catch {
    return { ok: false, error: `无法读取模型配置: ${settingsPath}` };
  }
  if (!proxyUrl) return { ok: false, error: '受控模型代理不可用，拒绝把原始密钥交给容器' };

  const dir = join(JARVIS_HOME, 'run');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${execId}.env`);
  // RISK-01：容器内只放代理地址与模型名，不包含任何 API Key
  // 占位凭据：让 CLI 认为已登录；真实密钥由宿主代理注入，容器内不存在
  const body = [
    `ANTHROPIC_BASE_URL=${proxyUrl}/api/anthropic`,
    `ANTHROPIC_API_KEY=proxy-managed-placeholder`,
    `ANTHROPIC_AUTH_TOKEN=proxy-managed-placeholder`,
    `ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL ?? env.ANTHROPIC_CUSTOM_MODEL_OPTION ?? 'glm-5.3'}`
  ].join('\n');
  writeFileSync(file, body, { mode: 0o600 });
  return { ok: true, file };
}

/**
 * 外部执行器任务（FIX1）：
 * 授权 → 隔离工作树 → 容器内执行 → 容器内校验 → 范围检查 → 提交 → 裁决 → 证据
 */
async function runExecutorTask(task, project) {
  if (task.executor !== 'claude-code') {
    recordAttempt({ task, project, phase: 'validate', status: 'rejected', blocked: 'unknown_executor', reason: task.executor });
    return { ok: false, blocked: 'unknown_executor', error: `未支持的执行器: ${task.executor}` };
  }

  const plan = resolveExecutorPlan(task, project);
  if (!plan.ok) {
    recordAttempt({ task, project, phase: 'validate', status: 'rejected', blocked: plan.blocked, reason: plan.error });
    return { ok: false, blocked: plan.blocked, error: plan.error };
  }
  const { resolved } = plan;

  const needsApproval = resolved.mode === 'acceptEdits' || resolved.commit;
  let approval = { valid: !needsApproval };
  if (needsApproval) {
    approval = findValidApproval(task.id, resolved.digest);
    if (!approval.valid) {
      recordAttempt({ task, project, phase: 'authorize', status: 'rejected', blocked: 'needs_approval', reason: approval.reason, plan: resolved });
      return { ok: false, blocked: 'needs_approval', error: `需要本地管理员审批：${approval.reason}` };
    }
  }

  const st = await iso.isolationStatus();
  if (!st.available) {
    recordAttempt({ task, project, phase: 'isolation', status: 'rejected', blocked: 'isolation_unavailable', reason: st.reason, plan: resolved });
    updateTask(task.id, { status: 'failed', error: `隔离不可用：${st.reason}` });
    return { ok: false, blocked: 'isolation_unavailable', error: st.reason };
  }

  // DEF-07：执行必须基于固定 commit 的一次性工作树
  if (!resolved.repo || !resolved.baseCommit) {
    const msg = '执行器任务必须提供 repo 与 base_commit（禁止直接在用户工作目录执行）';
    recordAttempt({ task, project, phase: 'validate', status: 'rejected', blocked: 'missing_worktree_spec', reason: msg, plan: resolved });
    return { ok: false, blocked: 'missing_worktree_spec', error: msg };
  }

  const claim = db()
    .prepare(`UPDATE tasks SET status='running', attempts=attempts+1, updated_at=?
              WHERE id=? AND status IN ('pending','authorized','retry_pending')`)
    .run(now(), task.id);
  if (claim.changes !== 1) {
    recordAttempt({ task, project, phase: 'claim', status: 'rejected', blocked: 'already_running', reason: '状态不允许执行', plan: resolved });
    return { ok: false, blocked: 'already_running', error: '任务已在运行或状态不允许执行' };
  }

  const execId = recordAttempt({ task, project, phase: 'execute', status: 'running', plan: resolved });
  const dest = join(JARVIS_HOME, 'worktrees', task.id);
  let credFile = null;
  let commit = null;
  let evidenceRefPreserve = null;

  try {
    rmSync(dest, { recursive: true, force: true });
    const wt = await ex.createWorktree({ repo: resolved.repo, commit: resolved.baseCommit, dest });
    if (!wt.ok) {
      finalizeAttempt(task, execId, { status: 'failed', reason: `创建隔离工作树失败: ${wt.error}` });
      return { ok: false, blocked: 'worktree_failed', error: wt.error };
    }
    const init = await ex.worktreeStatus(dest);
    if (!init.clean) {
      finalizeAttempt(task, execId, { status: 'failed', reason: `初始工作树不干净: ${init.raw.slice(0, 200)}` });
      return { ok: false, blocked: 'dirty_worktree', error: '初始工作树不干净，拒绝自动提交' };
    }

    const proxyUrl = await iso.egressProxyUrl();
    const cred = writeCredentialFile(execId, proxyUrl);
    if (!cred.ok) {
      finalizeAttempt(task, execId, { status: 'failed', reason: cred.error });
      return { ok: false, blocked: 'credentials_unavailable', error: cred.error };
    }
    credFile = cred.file;
    const containerName = `jarvis-exec-${execId}`;
    const res = await iso.runClaudeIsolated({
      name: containerName,
      workdir: dest,
      prompt: task.input,
      mode: resolved.mode,
      image: st.image,
      credentialsFile: credFile,
      proxyUrl
    });

    const cancelledNow = () => ['cancelled', 'cancel_requested'].includes(db().prepare('SELECT status FROM tasks WHERE id=?').get(task.id)?.status);
    if (cancelledNow()) {
      finalizeAttempt(task, execId, { status: 'cancelled', reason: '取消于校验前' });
      return { ok: false, blocked: 'cancelled', error: '任务已取消' };
    }

    // 容器内校验（与执行同一隔离环境）
    let verify = null;
    if (res.ok && resolved.profile) {
      db().prepare("UPDATE tasks SET status='verifying', updated_at=? WHERE id=? AND status='running'").run(now(), task.id);
      const vr = await iso.runInWorkdir({
        name: `jarvis-verify-${execId}`,
        workdir: dest,
        program: resolved.profile.program,
        args: JSON.parse(resolved.profile.argv || '[]'),
        image: st.image
      });
      verify = { exitCode: vr.exitCode, ok: vr.ok, output: vr.output, program: resolved.profile.program, argv: JSON.parse(resolved.profile.argv || '[]') };
    }

    // 修改范围检查
    const changed = await ex.changedFiles(dest);
    const outside = changed.filter((f) => !resolved.commitPaths.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')));
    const scopeOk = outside.length === 0;

    if (resolved.commit && scopeOk && !cancelledNow()) {
      const recheck = findValidApproval(task.id, resolved.digest);
      const gate = commitGate({ execOk: res.ok, verify, approval: recheck, commitPaths: resolved.commitPaths });
      if (gate.ok) {
        db().prepare("UPDATE tasks SET status='committing', updated_at=? WHERE id=? AND status='running'").run(now(), task.id);
        commit = await ex.gitCommit({ cwd: dest, message: resolved.commitMessage || `chore(executor): ${task.title}`, paths: resolved.commitPaths });
        // 让 commit 在仓库中保持可达（工作树是 detach 的，删除后会变成孤立对象）
        if (commit?.ok && commit.sha) {
          const refName = `refs/heads/jarvis/${task.id}`;
          const published = await ex.publishRef({ repo: resolved.repo, ref: refName, sha: commit.sha });
          commit.ref = refName;
          commit.refPublished = published.ok;
          // 复核：能从该引用真正取回同一个 SHA
          if (published.ok) {
            const verifyRef = await ex.revParseRef({ repo: resolved.repo, ref: refName });
            commit.refVerified = verifyRef === commit.sha;
            if (!commit.refVerified) commit.refPublished = false;
          }
          if (!commit.refPublished) {
            // 不丢成果：保留工作树路径写入证据，finally 不删除
            commit.refError = published.out?.slice(0, 300) ?? 'ref publish failed';
            evidenceRefPreserve = dest;
          }
        }
      } else {
        commit = { ok: false, skipped: true, reason: gate.reason };
      }
    } else if (resolved.commit && !scopeOk) {
      commit = { ok: false, skipped: true, reason: `修改超出授权范围: ${outside.join(', ')}` };
    }

    const verdict = computeVerdict({
      cancelled: res.cancelled,
      execOk: res.ok,
      verify,
      requiresVerify: Boolean(resolved.profile) || resolved.commit,
      commit,
      requiresCommit: resolved.commit,
      approvalValid: approval.valid,
      commitRefOk: resolved.commit ? commit?.refPublished !== false : undefined
    });

    const evidence = {
      isolated: true,
      network: st.network,
      image: st.image,
      worktree: { path: dest, base_commit: wt.sha, initialClean: init.clean, changed, outsideScope: outside },
      verify,
      commit,
      verdict,
      plan: {
        mode: resolved.mode,
        repo: resolved.repo,
        base_commit: resolved.baseCommit,
        verify_profile: resolved.verifyProfileId,
        commit: resolved.commit,
        commit_paths: resolved.commitPaths,
        digest: resolved.digest
      },
      authorization: { required: needsApproval, approval: approval.approval ? { id: approval.approval.id, digest: resolved.digest } : null }
    };
    if (approval.approval) db().prepare('UPDATE approvals SET used_at=? WHERE id=?').run(now(), approval.approval.id);

    finalizeAttempt(task, execId, {
      status: verdict.status === 'done' ? 'ok' : verdict.status === 'cancelled' ? 'cancelled' : 'failed',
      reason: verdict.reasons.join('; '),
      evidence,
      text: res.text
    });

    // 注意：ok 必须放在展开之后，否则会被 res.ok（容器执行成功）覆盖，
    // 造成「任务 failed 但 API 返回成功」的不一致（DEF-01）。
    return {
      ...res,
      ok: verdict.status === 'done',
      verdict,
      verify,
      commit,
      evidence,
      task: getTask(task.id),
      execution: execId
    };
  } finally {
    try { if (credFile) rmSync(credFile, { force: true }); } catch {}
    if (evidenceRefPreserve) {
      event('worktree.preserved', project.id, { task: task.id, path: evidenceRefPreserve });
    } else {
      try { await ex.removeWorktree({ repo: resolved.repo, dest }); } catch {}
    }
  }
}

function finalizeAttempt(task, execId, { status, reason, evidence, text }) {
  db()
    .prepare("UPDATE executions SET status=?, output=?, error=?, evidence=?, finished_at=? WHERE id=? AND status='running'")
    .run(status, text ?? '', reason ?? '', JSON.stringify(evidence ?? {}), now(), execId);
  const taskStatus = status === 'ok' ? 'done' : status === 'cancelled' ? 'cancelled' : 'failed';
  db()
    .prepare('UPDATE tasks SET status=?, output=COALESCE(NULLIF(?,\'\'),output), error=?, updated_at=? WHERE id=? AND status IN (\'running\',\'verifying\',\'committing\')')
    .run(taskStatus, text ?? '', reason ?? '', now(), task.id);
}

/* --------------------------------- Workflows --------------------------------- */

/**
 * 工作流 = 阶段序列；同一阶段内节点可并行，阶段间串行。
 * spec:
 * {
 *   maxRounds: 10,
 *   stages: [
 *     { name: '研究', parallel: true, nodes: [ {agent:'a', title:'..', input:'..'}, {agent:'b', ...} ] },
 *     { name: '汇总', nodes: [ {agent:'c', title:'..', input:'..', approve:false} ] }
 *   ]
 * }
 */
export function createWorkflow({ project: projectRef, name, spec, maxRounds }) {
  const p = getProject(projectRef);
  if (!spec?.stages?.length) throw new Error('spec.stages 不能为空');
  const id = newId('wfl');
  const t = now();
  db()
    .prepare('INSERT INTO workflows (id,project_id,name,status,spec,cursor,rounds,max_rounds,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, p.id, name, 'draft', JSON.stringify(spec), 0, 0, maxRounds ?? spec.maxRounds ?? 10, t, t);
  event('workflow.created', p.id, { name });
  return getWorkflow(id);
}

export function getWorkflow(ref) {
  const row = db().prepare('SELECT * FROM workflows WHERE id = ? OR name = ?').get(ref, ref);
  if (!row) throw new Error(`工作流不存在: ${ref}`);
  return row;
}

export function listWorkflows(projectRef) {
  if (!projectRef) return db().prepare('SELECT * FROM workflows ORDER BY created_at').all();
  const p = getProject(projectRef);
  return db().prepare('SELECT * FROM workflows WHERE project_id = ?').all(p.id);
}

export function setWorkflowStatus(ref, status) {
  const w = getWorkflow(ref);
  db().prepare('UPDATE workflows SET status=?, updated_at=? WHERE id=?').run(status, now(), w.id);
  return getWorkflow(w.id);
}

/**
 * 执行工作流。返回每个节点的真实执行结果。
 * 遇审批节点、项目暂停、或轮次超限会停下并报告原因。
 */
export async function runWorkflow(ref) {
  try {
    return await runWorkflowInner(ref);
  } catch (err) {
    const w = getWorkflow(ref);
    db().prepare('UPDATE workflows SET status=?, updated_at=? WHERE id=?').run('failed', now(), w.id);
    event('workflow.error', w.project_id, { name: w.name, error: err.message });
    return { ok: false, blocked: 'exception', error: err.message, workflow: getWorkflow(w.id) };
  }
}

async function runWorkflowInner(ref) {
  let w = getWorkflow(ref);
  const project = getProject(w.project_id);
  const spec = JSON.parse(w.spec);

  if (project.status === 'paused') return { ok: false, blocked: 'project_paused', workflow: w };
  if (w.rounds >= w.max_rounds) {
    db().prepare('UPDATE workflows SET status=?, updated_at=? WHERE id=?').run('failed', now(), w.id);
    return { ok: false, blocked: 'max_rounds', workflow: getWorkflow(w.id) };
  }

  db().prepare('UPDATE workflows SET status=?, updated_at=? WHERE id=?').run('running', now(), w.id);

  const results = [];
  let contextDigest = '';

  for (let stageIdx = w.cursor; stageIdx < spec.stages.length; stageIdx++) {
    const stage = spec.stages[stageIdx];

    // 审批门：阶段级
    if (stage.approve) {
      const approved = db()
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE workflow_id=? AND title LIKE ? AND approved_at IS NOT NULL")
        .get(w.id, `[审批] ${stage.name}%`);
      if (!approved.n) {
        createTask({
          project: project.id,
          workflowId: w.id,
          title: `[审批] ${stage.name}`,
          input: `阶段「${stage.name}」等待人工批准。`,
          needsApproval: true
        });
        db().prepare('UPDATE workflows SET status=?, cursor=?, updated_at=? WHERE id=?').run('paused', stageIdx, now(), w.id);
        return { ok: false, blocked: 'needs_approval', stage: stage.name, workflow: getWorkflow(w.id), results };
      }
    }

    const runNode = async (node) => {
      const input = [
        node.input ?? node.title,
        contextDigest ? `\n## 上游阶段结果\n${contextDigest}` : ''
      ].join('\n');

      if (node.executor === 'claude-code') {
        const t = createTask({
          project: project.id,
          workflowId: w.id,
          title: `[${stage.name}] ${node.title}`,
          input,
          kind: 'executor',
          executor: 'claude-code',
          executorConfig: node.executorConfig ?? { mode: 'plan' },
          needsApproval: Boolean(node.approve)
        });
        const r = await runTask(t.id);
        return { node: node.title, task: t.id, ok: r.ok, output: r.text ?? '', error: r.error ?? '' };
      }

      const t = createTask({
        project: project.id,
        workflowId: w.id,
        title: `[${stage.name}] ${node.title}`,
        input,
        assignee: node.agent,
        needsApproval: Boolean(node.approve)
      });
      const r = await runTask(t.id);
      return { node: node.title, agent: node.agent, task: t.id, ok: r.ok, output: r.text ?? '', error: r.error ?? '' };
    };

    const stageResults = stage.parallel ? await Promise.all(stage.nodes.map(runNode)) : [];
    if (!stage.parallel) {
      for (const n of stage.nodes) stageResults.push(await runNode(n));
    }

    results.push(...stageResults);
    contextDigest = stageResults
      .filter((r) => r.ok)
      .map((r) => `### ${r.node}\n${(r.output || '').slice(0, 1500)}`)
      .join('\n\n');

    const failed = stageResults.find((r) => !r.ok);
    if (failed) {
      db().prepare('UPDATE workflows SET status=?, cursor=?, rounds=rounds+1, updated_at=? WHERE id=?')
        .run('failed', stageIdx, now(), w.id);
      const failedWf = getWorkflow(w.id);
      await notify(`JARVIS 工作流「${failedWf.name}」在阶段「${stage.name}」失败：${failed.error || '未知原因'}`);
      return { ok: false, blocked: 'stage_failed', stage: stage.name, failed, workflow: failedWf, results };
    }

    db().prepare('UPDATE workflows SET cursor=?, updated_at=? WHERE id=?').run(stageIdx + 1, now(), w.id);
  }

  db().prepare('UPDATE workflows SET status=?, rounds=rounds+1, updated_at=? WHERE id=?').run('done', now(), w.id);
  const finished = getWorkflow(w.id);
  const lines = results.map((r) => `- ${r.node}: ${r.ok ? '完成' : '失败'}`);
  const note = await notify(`JARVIS 工作流「${finished.name}」已完成（项目 ${project.slug}）\n${lines.join('\n')}`);
  return { ok: true, workflow: finished, results, notified: note };
}

/**
 * 取消任务：杀掉执行器进程组，并把状态置为 cancelled。
 * 不做「假装已取消」——无法终止时如实返回失败。
 */
export async function cancelTask(ref) {
  const task = getTask(ref);
  const running = db()
    .prepare("SELECT * FROM executions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC")
    .all(task.id);
  if (!running.length) {
    return { ok: false, error: '该任务没有正在运行的执行', task: getTask(task.id) };
  }

  // 先标记取消意图，避免执行侧在终止过程中把任务写成 failed（DEF-02 竞态）
  db().prepare("UPDATE tasks SET status='cancel_requested', updated_at=? WHERE id=? AND status IN ('running','verifying','committing')").run(now(), task.id);

  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const waitGone = async (pid, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return !alive(pid);
  };

  const results = [];
  for (const exRow of running) {
    const pidFile = join(JARVIS_HOME, 'run', `${exRow.id}.pid`);
    let pid = null;
    try { pid = Number(readFileSync(pidFile, 'utf8').trim()); } catch { pid = null; }

    let confirmed = false;
    let escalated = false;
    let containerKilled = null;
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
      confirmed = await waitGone(pid, 5000);
      if (!confirmed) {
        escalated = true;
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
        confirmed = await waitGone(pid, 5000);
      }
    }

    // DEF-02：同一 Execution 的执行容器与验证容器都要纳入控制
    const targets = [`jarvis-exec-${exRow.id}`, `jarvis-verify-${exRow.id}`];
    const containerResults = [];
    for (const tname of targets) containerResults.push({ name: tname, ...(await iso.killContainer(tname)) });
    containerKilled = { results: containerResults };

    const daemonLost = containerResults.some((r) => r.reason === 'docker_daemon_unreachable');
    const allConfirmed = containerResults.every((r) => r.confirmed === true);
    // daemon 失联优先报告「无法确认」，绝不当作已停止
    const fullyStopped = daemonLost ? false : allConfirmed;

    if (fullyStopped) {
      db().prepare("UPDATE executions SET status='cancelled', finished_at=? WHERE id=? AND status='running'").run(now(), exRow.id);
      try { rmSync(pidFile, { force: true }); } catch {}
    }
    results.push({
      execution: exRow.id,
      pid,
      confirmedExit: fullyStopped,
      escalatedToSigkill: escalated,
      containers: containerKilled.results
    });
  }

  const allConfirmed = results.every((r) => r.confirmedExit);
  if (!allConfirmed) {
    db().prepare("UPDATE tasks SET status='cancel_requested', updated_at=? WHERE id=? AND status NOT IN ('cancelled','done')").run(now(), task.id);
    event('task.cancel_unconfirmed', task.project_id, { title: task.title, results });
    return {
      ok: false,
      error: '无法确认执行器已终止（已尝试 SIGTERM→SIGKILL），状态标记为 cancel_requested，需人工核查',
      task: getTask(task.id),
      results
    };
  }

  db().prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=? AND status IN ('running','verifying','committing','cancel_requested')").run(now(), task.id);
  event('task.cancelled', task.project_id, { title: task.title, results });
  return { ok: true, task: getTask(task.id), results };
}

/**
 * 审计任务：在固定 commit 的只读工作树上执行。
 * - 不接受 HEAD，必须显式 commit
 * - 只读模式，不得修改被审计代码
 * - 契约文本随任务冻结进证据
 */
/**
 * 审计任务（DEF-07）：与执行器一致的隔离原则。
 * 固定 commit → 一次性工作树 → 容器内只读执行（plan）→ 校验未被修改。
 * 注意：审计任务执行成功 ≠ 独立审计结论 PASS。
 */
async function runAuditTask(task, project) {
  const cfg = JSON.parse(task.executor_config || '{}');
  const { repo, commit, contract } = cfg;
  if (!repo || !commit) {
    return { ok: false, blocked: 'bad_audit_config', error: '审计任务必须提供 repo 与 commit' };
  }
  if (!contract) {
    return { ok: false, blocked: 'no_contract', error: '审计任务必须提供冻结的验收契约（contract）' };
  }

  const rc = resolveProjectPath(repo, project.dir);
  if (!rc.ok) {
    recordAttempt({ task, project, phase: 'validate', status: 'rejected', blocked: 'repo_outside_project', reason: rc.error });
    return { ok: false, blocked: 'repo_outside_project', error: rc.error };
  }

  const st = await iso.isolationStatus();
  if (!st.available) {
    recordAttempt({ task, project, phase: 'isolation', status: 'rejected', blocked: 'isolation_unavailable', reason: st.reason });
    return { ok: false, blocked: 'isolation_unavailable', error: st.reason };
  }

  const claim = db()
    .prepare("UPDATE tasks SET status='running', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('pending','authorized','retry_pending')")
    .run(now(), task.id);
  if (claim.changes !== 1) {
    return { ok: false, blocked: 'already_running', error: '任务已在运行或状态不允许执行' };
  }

  const execId = newId('exe');
  db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, task.id, null, 'running', 'claude-code-audit-isolated', '', now());

  const dest = join(JARVIS_HOME, 'audit', task.id);
  let credFile = null;
  let preserved = false;
  try {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(JARVIS_HOME, 'audit'), { recursive: true });

    const wt = await ex.createWorktree({ repo: rc.cwd, commit, dest });
    if (!wt.ok) {
      finalizeAttempt(task, execId, { status: 'failed', reason: `审计工作树创建失败: ${wt.error}` });
      return { ok: false, blocked: 'worktree_failed', error: wt.error };
    }
    const init = await ex.worktreeStatus(dest);
    if (!init.clean) {
      finalizeAttempt(task, execId, { status: 'failed', reason: '审计工作树初始不干净' });
      return { ok: false, blocked: 'dirty_worktree', error: '审计工作树初始不干净' };
    }

    const proxyUrl = await iso.egressProxyUrl();
    const cred = writeCredentialFile(execId, proxyUrl);
    if (!cred.ok) {
      finalizeAttempt(task, execId, { status: 'failed', reason: cred.error });
      return { ok: false, blocked: 'credentials_unavailable', error: cred.error };
    }
    credFile = cred.file;

    const prompt = [
      '你是独立审计员。只读审计，禁止修改任何文件。',
      '',
      '## 被审计版本',
      `固定 commit: ${wt.sha}`,
      '',
      '## 冻结的验收契约',
      contract,
      '',
      '## 要求',
      '逐条核对契约，给出 PASS / FAIL / 无法判定，并给出证据（文件与行号）。',
      '不要臆造未看到的代码。'
    ].join('\n');

    const res = await iso.runClaudeIsolated({
      name: `jarvis-audit-${execId}`,
      workdir: dest,
      prompt,
      mode: 'plan',
      image: st.image,
      credentialsFile: credFile,
      proxyUrl
    });

    const after = await ex.worktreeStatus(dest);
    const evidence = {
      isolated: true,
      network: st.network,
      image: st.image,
      audit: {
        repo: rc.cwd,
        commit: wt.sha,
        contract_sha256: sha256(contract),
        worktreeClean: after.clean,
        dirty: after.raw.slice(0, 300)
      }
    };

    const ok = res.ok && after.clean;
    const reason = res.ok ? (after.clean ? '' : '审计过程修改了被审计代码') : (res.error ?? '执行失败');
    finalizeAttempt(task, execId, { status: ok ? 'ok' : 'failed', reason, evidence, text: res.text });

    return { ...res, ok, evidence, task: getTask(task.id), execution: execId };
  } finally {
    try { if (credFile) rmSync(credFile, { force: true }); } catch {}
    if (!preserved) {
      try { await ex.removeWorktree({ repo: rc.cwd, dest }); } catch {}
    }
  }
}

/* ----------------------------- Verify Profiles ------------------------------- */

/**
 * 登记可信校验配置——只能由本地管理员入口调用（CLI）。
 * 校验命令由管理员固定，任务只能引用 id（AC-01）。
 */
export function createVerifyProfile({ project: projectRef, name, program, argv = [], cwd, timeoutMs = 300_000, createdBy = 'local-operator' }) {
  const project = getProject(projectRef);
  if (!name || !program) throw new Error('必须提供 name 与 program');
  if (!Array.isArray(argv)) throw new Error('argv 必须是数组');
  const shellNames = ['sh', 'bash', 'zsh', 'dash', 'csh', 'ksh'];
  const base = String(program).split('/').pop();
  if (shellNames.includes(program) || shellNames.includes(base)) {
    throw new Error('不允许把 shell 解释器登记为校验程序');
  }
  const id = newId('vpr');
  db()
    .prepare('INSERT INTO verify_profiles (id,project_id,name,program,argv,cwd,timeout_ms,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, project.id, name, program, JSON.stringify(argv), cwd ?? null, timeoutMs, createdBy, now());
  event('verify_profile.created', project.id, { name, program, argv });
  return getVerifyProfile(id);
}

export function getVerifyProfile(ref) {
  const row = db().prepare('SELECT * FROM verify_profiles WHERE id = ? OR name = ?').get(ref, ref);
  if (!row) throw new Error(`校验配置不存在: ${ref}`);
  return row;
}

export function listVerifyProfiles(projectRef) {
  if (!projectRef) return db().prepare('SELECT * FROM verify_profiles ORDER BY created_at').all();
  const p = getProject(projectRef);
  return db().prepare('SELECT * FROM verify_profiles WHERE project_id = ?').all(p.id);
}

/* -------------------------------- Notifications ------------------------------- */

export function setSetting(key, value) {
  db().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  return { key, value };
}

export function getSetting(key) {
  return db().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

/**
 * 通过 OpenClaw 已有的飞书通道发通知。
 * 失败不抛异常：通知失败不应该让工作流回滚。
 */
async function notify(text) {
  const target = process.env.JARVIS_NOTIFY_TARGET || getSetting('notify_target');
  if (!target) return { sent: false, reason: 'notify_target 未配置' };
  const { execFile } = await import('node:child_process');
  const bin = join(HOME, '.openclaw/bin/openclaw');
  return new Promise((resolve) => {
    execFile(
      bin,
      ['message', 'send', '--channel', 'feishu', '--target', target, '-m', text],
      { timeout: 60_000, env: { ...process.env, PATH: `${join(HOME, '.openclaw/bin')}:${process.env.PATH}` } },
      (err, stdout, stderr) => {
        const ok = !err;
        event('notify.sent', null, { ok, error: ok ? '' : String(stderr || err).slice(0, 200) });
        resolve({ sent: ok, error: ok ? '' : String(stderr || err).slice(0, 300) });
      }
    );
  });
}

/* --------------------------------- Reporting --------------------------------- */

export function projectStatus(projectRef) {
  const p = getProject(projectRef);
  const agents = listAgents(p.id);
  const tasks = listTasks(p.id);
  const byStatus = tasks.reduce((acc, t) => ((acc[t.status] = (acc[t.status] ?? 0) + 1), acc), {});
  return {
    project: p,
    agents: agents.map((a) => ({ name: a.name, model: a.model, status: a.status })),
    tasks: { total: tasks.length, byStatus },
    pendingDecisions: tasks.filter((t) => t.needs_approval && !t.approved_at).map((t) => ({ id: t.id, title: t.title }))
  };
}
