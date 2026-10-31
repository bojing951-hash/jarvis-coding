/**
 * 调度服务层：Project / Agent / Conversation / Task / Execution 的真实操作。
 * CLI 与 MCP 共用这一层，保证两条入口行为一致。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase, now, newId, slugify } from './db.mjs';
import * as oc from './oc.mjs';
import * as ex from './executor.mjs';

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
export async function talk({ agent: agentRef, message, conversation: convRef, sessionKey }) {
  const a = getAgent(agentRef);
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
  const a = assignee ? getAgent(assignee) : null;
  if (a && a.project_id !== project.id) throw new Error('Agent 不属于该项目，禁止跨项目直接指派');
  const id = newId('tsk');
  const t = now();
  db()
    .prepare(`INSERT INTO tasks (id,project_id,workflow_id,parent_task_id,title,kind,status,assignee_agent_id,input,max_attempts,needs_approval,executor,executor_config,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project.id, workflowId ?? null, parentTaskId ?? null, title, kind ?? 'agent_turn', 'pending',
         a?.id ?? null, input ?? '', maxAttempts ?? 3, needsApproval ? 1 : 0,
         executor ?? 'agent', JSON.stringify(executorConfig ?? {}), t, t);
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
async function runExecutorTask(task, project) {
  if (task.executor !== 'claude-code') {
    return { ok: false, blocked: 'unknown_executor', error: `未支持的执行器: ${task.executor}` };
  }
  const cfg = JSON.parse(task.executor_config || '{}');
  const cwd = cfg.cwd || join(project.dir, 'exec');
  const mode = cfg.mode || 'plan';
  if (mode === 'acceptEdits' && cfg.approved !== true) {
    return { ok: false, blocked: 'needs_approval', error: '写模式需要先审批（executor_config.approved=true 且任务已批准）' };
  }
  mkdirSync(cwd, { recursive: true });

  updateTask(task.id, { status: 'running', attempts: task.attempts + 1 });
  const execId = newId('exe');
  const started = now();
  db()
    .prepare('INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)')
    .run(execId, task.id, null, 'running', 'claude-code', cwd, started);

  const res = await ex.runClaudeCode({
    cwd,
    prompt: task.input,
    mode,
    allowedTools: cfg.allowedTools,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs
  });

  db()
    .prepare('UPDATE executions SET status=?, model=?, output=?, error=?, evidence=?, finished_at=? WHERE id=?')
    .run(res.ok ? 'ok' : 'failed', 'claude-code', res.text ?? '', res.ok ? '' : res.error ?? '',
         JSON.stringify(res.evidence ?? {}), now(), execId);

  if (res.ok) updateTask(task.id, { status: 'done', output: res.text, error: '' });
  else updateTask(task.id, { status: 'failed', error: res.error ?? '' });

  return { ...res, task: getTask(task.id), execution: execId };
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
      return { ok: false, blocked: 'stage_failed', stage: stage.name, failed, workflow: getWorkflow(w.id), results };
    }

    db().prepare('UPDATE workflows SET cursor=?, updated_at=? WHERE id=?').run(stageIdx + 1, now(), w.id);
  }

  db().prepare('UPDATE workflows SET status=?, rounds=rounds+1, updated_at=? WHERE id=?').run('done', now(), w.id);
  return { ok: true, workflow: getWorkflow(w.id), results };
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
