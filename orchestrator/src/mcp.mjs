#!/usr/bin/env node
/**
 * JARVIS 控制面 MCP Server（stdio，零外部依赖）。
 *
 * 目的：让飞书里的 JARVIS 通过工具调用管理项目/Agent/任务，
 * 而不是给它开放 Shell 权限。
 *
 * 协议：JSON-RPC 2.0，按行分隔（MCP stdio 约定）。
 */
import * as svc from './service.mjs';
import * as oc from './oc.mjs';

const SERVER_INFO = { name: 'jarvis-control', version: '1.0.0' };

const TOOLS = [
  {
    name: 'project_create',
    description: '创建一个项目。项目之间会话、资料、权限隔离。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '项目名称' }, slug: { type: 'string', description: '可选英文标识' } },
      required: ['name']
    }
  },
  {
    name: 'project_list',
    description: '列出所有项目及状态。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'project_status',
    description: '查看某项目的 Agent、任务统计与等待用户决策的事项。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] }
  },
  {
    name: 'project_pause',
    description: '暂停项目：保留状态，不再执行新任务。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] }
  },
  {
    name: 'project_resume',
    description: '恢复项目。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] }
  },
  {
    name: 'agent_create',
    description: '在项目内创建 Agent：指定模型与角色。模型与角色相互独立，可任意组合。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        name: { type: 'string', description: '小写字母/数字/连字符' },
        model: { type: 'string', description: '形如 zai/glm-4.6 或 openai/gpt-4o' },
        role: { type: 'string', description: '角色指令，与模型无关' }
      },
      required: ['project', 'name', 'model']
    }
  },
  {
    name: 'agent_list',
    description: '列出项目内 Agent 及其模型与状态。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } }
  },
  {
    name: 'agent_set_role',
    description: '修改 Agent 的角色指令，不改变其模型与会话。',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: '名称，或 项目slug/名称' }, role: { type: 'string' } },
      required: ['agent', 'role']
    }
  },
  {
    name: 'agent_set_model',
    description: '替换 Agent 使用的模型，保留其角色与会话。',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: '名称，或 项目slug/名称' }, model: { type: 'string' } },
      required: ['agent', 'model']
    }
  },
  {
    name: 'conversation_create',
    description: '为 Agent 新建一个独立会话（上下文与其它会话互不干扰）。',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' }, title: { type: 'string' } },
      required: ['agent']
    }
  },
  {
    name: 'conversation_list',
    description: '列出 Agent 的独立会话。',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] }
  },
  {
    name: 'talk',
    description: '向指定 Agent 发送消息并取得真实回复。不传 conversation 时自动新建独立会话；传入则续接该会话上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '名称，或 项目slug/名称' },
        message: { type: 'string' },
        project: { type: 'string', description: '可选：项目 slug，用于消解同名 Agent 歧义' },
        conversation: { type: 'string', description: '会话 id，可省略' }
      },
      required: ['agent', 'message']
    }
  },
  {
    name: 'handoff',
    description: '把任务与成果从一个 Agent 交接给另一个 Agent 真实执行，返回接收方的实际执行结果。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        from: { type: 'string', description: '名称，或 项目slug/名称' },
        to: { type: 'string', description: '名称，或 项目slug/名称' },
        requirement: { type: 'string', description: '原始要求' },
        artifact: { type: 'string', description: '需要传递的成果' },
        context: { type: 'string' },
        constraints: { type: 'string' }
      },
      required: ['project', 'from', 'to', 'requirement']
    }
  },
  {
    name: 'task_create',
    description: '创建任务，可指定执行 Agent 与是否需人工审批。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string' },
        input: { type: 'string' },
        agent: { type: 'string' },
        needs_approval: { type: 'boolean' },
        max_attempts: { type: 'number' }
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'task_list',
    description: '列出任务及状态。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string' } } }
  },
  {
    name: 'task_approve',
    description: '人工批准一个需要审批的任务。',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] }
  },
  {
    name: 'task_run',
    description: '执行任务并返回真实结果。失败会返回真实错误，不会伪造成功。',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] }
  },
  {
    name: 'workflow_create',
    description: '创建工作流。spec.stages 为阶段数组；同阶段节点可并行，阶段间串行；stage.approve 为审批门。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        name: { type: 'string' },
        spec: { type: 'object', description: '{"stages":[{"name":"研究","parallel":true,"nodes":[{"agent":"a","title":"..","input":".."}]}]}' }
      },
      required: ['project', 'name', 'spec']
    }
  },
  {
    name: 'workflow_run',
    description: '执行工作流，返回每个节点的真实结果。遇审批门或失败会停下并说明原因。',
    inputSchema: { type: 'object', properties: { workflow: { type: 'string' } }, required: ['workflow'] }
  },
  {
    name: 'workflow_list',
    description: '列出工作流及状态。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } }
  },
  {
    name: 'workflow_pause',
    description: '暂停工作流。',
    inputSchema: { type: 'object', properties: { workflow: { type: 'string' } }, required: ['workflow'] }
  },
  {
    name: 'models_list',
    description: '列出当前可用模型（用于创建 Agent 时选择）。',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' } } }
  }
];

const ok = (text) => ({ content: [{ type: 'text', text }] });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });

async function callTool(name, args) {
  switch (name) {
    case 'project_create':
      return ok(JSON.stringify(svc.createProject({ name: args.name, slug: args.slug }), null, 2));
    case 'project_list':
      return ok(JSON.stringify(svc.listProjects().map((p) => ({ slug: p.slug, name: p.name, status: p.status })), null, 2));
    case 'project_status':
      return ok(JSON.stringify(svc.projectStatus(args.project), null, 2));
    case 'project_pause':
      return ok(JSON.stringify(svc.setProjectStatus(args.project, 'paused')));
    case 'project_resume':
      return ok(JSON.stringify(svc.setProjectStatus(args.project, 'active')));
    case 'agent_create': {
      const a = await svc.createAgent({ project: args.project, name: args.name, model: args.model, role: args.role });
      return ok(JSON.stringify({ name: a.name, model: a.model, workspace: a.workspace }, null, 2));
    }
    case 'agent_list':
      return ok(JSON.stringify(svc.listAgents(args.project).map((a) => ({ name: a.name, model: a.model, status: a.status })), null, 2));
    case 'agent_set_role':
      return ok(JSON.stringify(svc.setAgentRole(args.agent, args.role)));
    case 'agent_set_model':
      return ok(JSON.stringify(svc.setAgentModel(args.agent, args.model)));
    case 'conversation_create':
      return ok(JSON.stringify(svc.createConversation({ agent: args.agent, title: args.title })));
    case 'conversation_list':
      return ok(JSON.stringify(svc.listConversations(args.agent).map((c) => ({ id: c.id, title: c.title })), null, 2));
    case 'talk': {
      const r = await svc.talk({ agent: args.agent, message: args.message, conversation: args.conversation, project: args.project });
      return r.ok
        ? ok(JSON.stringify({ agent: r.agent, model: r.model, conversation: r.sessionKey, reply: r.text }, null, 2))
        : err(JSON.stringify({ agent: args.agent, error: r.error, blocked: r.blocked ?? null }, null, 2));
    }
    case 'handoff': {
      const r = await svc.handoff({
        project: args.project,
        from: args.from,
        to: args.to,
        requirement: args.requirement,
        artifact: args.artifact ?? '',
        context: args.context,
        constraints: args.constraints
      });
      return r.ok
        ? ok(JSON.stringify({ from: args.from, to: args.to, task: r.task.id, status: r.task.status, result: r.text }, null, 2))
        : err(JSON.stringify({ error: r.error, task: r.task?.id, status: r.task?.status }, null, 2));
    }
    case 'task_create':
      return ok(JSON.stringify(svc.createTask({
        project: args.project,
        title: args.title,
        input: args.input ?? '',
        assignee: args.agent,
        needsApproval: Boolean(args.needs_approval),
        maxAttempts: args.max_attempts
      })));
    case 'task_list':
      return ok(JSON.stringify(svc.listTasks(args.project, args.status).map((t) => ({
        id: t.id, title: t.title, status: t.status, attempts: t.attempts
      })), null, 2));
    case 'task_approve':
      return ok(JSON.stringify(svc.approveTask(args.task)));
    case 'task_run': {
      const r = await svc.runTask(args.task);
      return r.ok ? ok(JSON.stringify({ status: r.task.status, output: r.text })) : err(JSON.stringify({ error: r.error, status: r.task?.status }));
    }
    case 'workflow_create':
      return ok(JSON.stringify(svc.createWorkflow({ project: args.project, name: args.name, spec: args.spec })));
    case 'workflow_run': {
      const r = await svc.runWorkflow(args.workflow);
      return ok(JSON.stringify({ ok: r.ok, blocked: r.blocked ?? null, results: r.results, workflow: r.workflow?.status }, null, 2));
    }
    case 'workflow_list':
      return ok(JSON.stringify(svc.listWorkflows(args.project).map((w) => ({ id: w.id, name: w.name, status: w.status, cursor: w.cursor })), null, 2));
    case 'workflow_pause':
      return ok(JSON.stringify(svc.setWorkflowStatus(args.workflow, 'paused')));
    case 'models_list':
      return ok(JSON.stringify((await oc.listModels(args.provider)).map((m) => m.ref), null, 2));
    default:
      return err(`未知工具: ${name}`);
  }
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    await handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      }
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: err(e.message) });
    }
  }
  if (method?.startsWith('notifications/')) return;
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
}
