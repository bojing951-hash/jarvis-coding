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
import { validateExecutorConfig, resolveProjectPath, taskDigest, commitGate, canonicalJson, sha256 } from './security.mjs';

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
  if (task.needs_approval && !task.approved_at) {
    return { ok: false, blocked: 'needs_approval', error: '该任务需要人工审批后才能执行' };
  }
  if (task.attempts >= task.max_attempts) {
    updateTask(task.id, { status: 'failed', error: '超过最大重试次数' });
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
  updateTask(task.id, { status: 'running', attempts: task.attempts + 1 });

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

  const resolved = { mode, cwd: pathCheck.cwd, verifyProfileId, commit, commitPaths, profile };
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
export function issueApproval({ task: taskRef, ttlHours = 24, issuedBy = 'local-operator' }) {
  const task = getTask(taskRef);
  const project = getProject(task.project_id);
  const plan = resolveExecutorPlan(task, project);
  if (!plan.ok) return { ok: false, error: `${plan.blocked}: ${plan.error}` };
  const { resolved } = plan;

  const id = newId('apv');
  const issued = now();
  const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
  const scope = {
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
async function runExecutorTask(task, project) {
  if (task.executor !== 'claude-code') {
    return { ok: false, blocked: 'unknown_executor', error: `未支持的执行器: ${task.executor}` };
  }

  const plan = resolveExecutorPlan(task, project);
  if (!plan.ok) return { ok: false, blocked: plan.blocked, error: plan.error };
  const { resolved } = plan;
  const { mode, cwd, commitPaths } = resolved;

  // 写模式或提交必须有有效审批（AC-02 / AC-09：不认 executor_config.approved 与历史 approved_at）
  const needsApproval = mode === 'acceptEdits' || resolved.commit;
  let approval = { valid: !needsApproval, reason: '' };
  if (needsApproval) {
    approval = findValidApproval(task.id, resolved.digest);
    if (!approval.valid) {
      return { ok: false, blocked: 'needs_approval', error: `需要本地管理员审批：${approval.reason}` };
    }
  }

  // 并发保护：只有 pending/retry_pending/approved/failed 能转为 running（AC-07）
  const claim = db()
    .prepare(`UPDATE tasks SET status='running', attempts=attempts+1, updated_at=?
              WHERE id=? AND status IN ('pending','retry_pending','approved','failed')`)
    .run(now(), task.id);
  if (claim.changes !== 1) {
    return { ok: false, blocked: 'already_running', error: '任务已在运行或状态不允许执行' };
  }

  mkdirSync(cwd, { recursive: true });
  const execId = newId('exe');
  const started = now();
  db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, task.id, null, 'running', 'claude-code', cwd, started);

  const runDir = join(JARVIS_HOME, 'run');
  mkdirSync(runDir, { recursive: true });
  const pidFile = join(runDir, `${execId}.pid`);

  const res = await ex.runClaudeCode({
    cwd,
    prompt: task.input,
    mode,
    maxTurns: resolved.maxTurns,
    timeoutMs: resolved.timeoutMs,
    onPid: (pid) => {
      try { writeFileSync(pidFile, String(pid), { mode: 0o600 }); } catch {}
      db().prepare('UPDATE executions SET evidence=? WHERE id=?').run(JSON.stringify({ pid }), execId);
    }
  });
  try { rmSync(pidFile, { force: true }); } catch {}

  const isCancelled = () =>
    db().prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)?.status === 'cancelled';

  // 校验（只认登记配置，不经 shell）
  let verify = null;
  if (res.ok && !isCancelled() && resolved.profile) {
    verify = await ex.runVerifyProfile({
      program: resolved.profile.program,
      argv: JSON.parse(resolved.profile.argv || '[]'),
      cwd: resolved.profile.cwd ? resolveProjectPath(resolved.profile.cwd, project.dir).cwd ?? cwd : cwd,
      timeoutMs: resolved.profile.timeout_ms
    });
  }

  // 提交门禁：执行成功 ≠ 可以提交
  let commit = null;
  if (resolved.commit && !isCancelled()) {
    const gate = commitGate({
      execOk: res.ok,
      verify,
      approval: needsApproval ? { valid: true } : approval,
      commitPaths
    });
    if (gate.ok) {
      commit = await ex.gitCommit({
        cwd,
        message: JSON.parse(task.executor_config || '{}').commit_message || `chore(executor): ${task.title}`,
        paths: commitPaths
      });
    } else {
      commit = { ok: false, skipped: true, reason: gate.reason };
    }
  }

  const approvalRecord = approval.valid ? { id: approval.approval?.id, digest: resolved.digest } : null;
  if (approvalRecord?.id) {
    db().prepare('UPDATE approvals SET used_at=? WHERE id=?').run(now(), approvalRecord.id);
  }

  const evidence = {
    ...(res.evidence ?? {}),
    verify,
    commit,
    plan: {
      mode,
      cwd,
      verify_profile: resolved.verifyProfileId,
      commit: resolved.commit,
      commit_paths: commitPaths,
      digest: resolved.digest
    },
    authorization: { required: needsApproval, approval: approvalRecord }
  };

  const cancelledNow = res.cancelled || isCancelled();
  const finalStatus = cancelledNow ? 'cancelled' : res.ok ? 'ok' : 'failed';
  db()
    .prepare("UPDATE executions SET status=?, model=?, output=?, error=?, evidence=?, finished_at=? WHERE id=? AND status='running'")
    .run(finalStatus, 'claude-code', res.text ?? '', res.ok ? '' : res.error ?? '',
         JSON.stringify(evidence), now(), execId);

  if (cancelledNow) {
    db().prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=? AND status='running'").run(now(), task.id);
  } else if (res.ok) {
    db().prepare("UPDATE tasks SET status='done', output=?, error='', updated_at=? WHERE id=? AND status='running'")
      .run(res.text ?? '', now(), task.id);
  } else {
    db().prepare("UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=? AND status='running'")
      .run(res.error ?? '', now(), task.id);
  }

  return { ...res, evidence, verify, commit, approval: approvalRecord, task: getTask(task.id), execution: execId };
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
export function cancelTask(ref) {
  const task = getTask(ref);
  const running = db()
    .prepare("SELECT * FROM executions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC")
    .all(task.id);
  if (!running.length) {
    return { ok: false, error: '该任务没有正在运行的执行', task: getTask(task.id) };
  }
  const results = [];
  for (const exRow of running) {
    const pidFile = join(JARVIS_HOME, 'run', `${exRow.id}.pid`);
    let pid = null;
    try { pid = Number(readFileSync(pidFile, 'utf8').trim()); } catch { pid = null; }
    let killed = false;
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(-pid, 'SIGTERM'); killed = true; } catch {
        try { process.kill(pid, 'SIGTERM'); killed = true; } catch { killed = false; }
      }
    }
    db().prepare("UPDATE executions SET status='cancelled', finished_at=? WHERE id=?").run(now(), exRow.id);
    try { rmSync(pidFile, { force: true }); } catch {}
    results.push({ execution: exRow.id, pid, killed });
  }
  const allKilled = results.every((r) => r.killed);
  // AC-06：无法确认终止时不得虚报「已取消」
  if (!allKilled) {
    db().prepare("UPDATE tasks SET status='cancel_requested', updated_at=? WHERE id=?").run(now(), task.id);
    event('task.cancel_unconfirmed', task.project_id, { title: task.title, results });
    return { ok: false, error: '无法确认执行器已终止，状态标记为 cancel_requested，需人工核查', task: getTask(task.id), results };
  }
  db().prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?").run(now(), task.id);
  event('task.cancelled', task.project_id, { title: task.title });
  return { ok: true, task: getTask(task.id), results };
}

/**
 * 审计任务：在固定 commit 的只读工作树上执行。
 * - 不接受 HEAD，必须显式 commit
 * - 只读模式，不得修改被审计代码
 * - 契约文本随任务冻结进证据
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

  const dest = join(JARVIS_HOME, 'audit', `${task.id}`);
  mkdirSync(join(JARVIS_HOME, 'audit'), { recursive: true });
  const wt = await ex.createFrozenWorktree({ repo, commit, dest });
  if (!wt.ok) return { ok: false, blocked: 'worktree_failed', error: wt.error };

  updateTask(task.id, { status: 'running', attempts: task.attempts + 1 });
  const execId = newId('exe');
  const started = now();
  db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, task.id, null, 'running', 'claude-code-audit', wt.path, started);

  const prompt = [
    '你是独立审计员。只读审计，禁止修改任何文件。',
    '',
    `## 被审计版本`,
    `仓库: ${repo}`,
    `固定 commit: ${wt.sha}`,
    '',
    '## 冻结的验收契约',
    contract,
    '',
    '## 要求',
    '逐条核对契约，给出 PASS / FAIL / 无法判定，并给出证据（文件与行号）。',
    '不要臆造未看到的代码。'
  ].join('\n');

  const res = await ex.runClaudeCode({ cwd: wt.path, prompt, mode: 'plan' });

  // 证明审计没有改动被审计代码
  const dirty = await new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile('git', ['-C', wt.path, 'status', '--porcelain'], { timeout: 30_000 }, (e, so) =>
        resolve((so || '').trim())
      );
    });
  });

  const evidence = {
    ...(res.evidence ?? {}),
    audit: { repo, commit: wt.sha, contract, path: wt.path, worktreeClean: dirty === '' }
  };
  db()
    .prepare("UPDATE executions SET status=?, model=?, output=?, error=?, evidence=?, finished_at=? WHERE id=? AND status='running'")
    .run(res.ok ? 'ok' : 'failed', 'claude-code-audit', res.text ?? '', res.ok ? '' : res.error ?? '',
         JSON.stringify(evidence), now(), execId);

  await ex.removeFrozenWorktree({ repo, dest });

  if (res.ok) updateTask(task.id, { status: 'done', output: res.text, error: '' });
  else updateTask(task.id, { status: 'failed', error: res.error ?? '' });
  return { ...res, evidence, task: getTask(task.id), execution: execId };
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
