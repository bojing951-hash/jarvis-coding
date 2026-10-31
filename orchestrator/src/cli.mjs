#!/usr/bin/env node
/**
 * jarvisctl —— JARVIS 调度层命令行入口。
 * 面向自动化与调试；飞书内的自然语言入口走 MCP（mcp.mjs），两者共用 service.mjs。
 */
import * as svc from './service.mjs';
import * as oc from './oc.mjs';
import { assertOperator, operatorKeyPath } from './security.mjs';

const argv = process.argv.slice(2);

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const opt = parseArgs(argv);
const [group, action, positional] = opt._;
const asJson = Boolean(opt.json) || !process.stdout.isTTY;

function fail(message, extra = {}) {
  const payload = { ok: false, error: message, ...extra };
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else console.error(`错误: ${message}`);
  process.exit(1);
}

function print(rows) {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (Array.isArray(rows)) {
    for (const r of rows) console.log(JSON.stringify(r));
  } else console.log(JSON.stringify(rows, null, 2));
}

const require_ = (name) => {
  if (!opt[name]) fail(`缺少参数 --${name}`);
  return opt[name];
};

async function main() {
  try {
    switch (`${group}:${action ?? ''}`) {
      /* projects */
      case 'project:create': {
        print(svc.createProject({ name: require_('name'), slug: opt.slug }));
        break;
      }
      case 'project:list':
        print(svc.listProjects().map((p) => ({ id: p.id, slug: p.slug, name: p.name, status: p.status })));
        break;
      case 'project:show':
        print(svc.projectStatus(require_('project')));
        break;
      case 'project:pause':
        print(svc.setProjectStatus(require_('project'), 'paused'));
        break;
      case 'project:resume':
        print(svc.setProjectStatus(require_('project'), 'active'));
        break;

      /* agents */
      case 'agent:create': {
        const a = await svc.createAgent({
          project: require_('project'),
          name: require_('name'),
          model: require_('model'),
          role: opt.role,
          roleFile: opt['role-file']
        });
        print({ id: a.id, name: a.name, model: a.model, openclaw_agent_id: a.openclaw_agent_id, workspace: a.workspace });
        break;
      }
      case 'agent:list':
        print(svc.listAgents(opt.project).map((a) => ({ name: a.name, model: a.model, status: a.status, project_id: a.project_id })));
        break;
      case 'agent:role':
        print(svc.setAgentRole(require_('agent'), require_('role')));
        break;
      case 'agent:model':
        print(svc.setAgentModel(require_('agent'), require_('model')));
        break;
      case 'agent:pause':
        print(svc.setAgentStatus(require_('agent'), 'paused'));
        break;
      case 'agent:resume':
        print(svc.setAgentStatus(require_('agent'), 'active'));
        break;

      /* conversations */
      case 'conv:create':
        print(svc.createConversation({ agent: require_('agent'), title: opt.title }));
        break;
      case 'conv:list':
        print(svc.listConversations(require_('agent')).map((c) => ({ id: c.id, title: c.title, session_key: c.session_key })));
        break;

      /* talk */
      case 'talk:': {
        const r = await svc.talk({
          agent: require_('agent'),
          message: require_('message'),
          conversation: opt.conversation,
          sessionKey: opt['session-key']
        });
        print(r);
        if (!r.ok) process.exit(2);
        break;
      }

      /* tasks */
      case 'task:create':
        print(
          svc.createTask({
            project: require_('project'),
            title: require_('title'),
            input: opt.input ?? '',
            assignee: opt.agent,
            kind: opt.kind,
            needsApproval: Boolean(opt['needs-approval']),
            maxAttempts: opt['max-attempts'] ? Number(opt['max-attempts']) : undefined,
            kind: opt.kind,
            executor: opt.executor,
            executorConfig: opt.kind === 'audit'
              ? { repo: opt.repo, commit: opt.commit, contract: opt.contract }
              : opt.executor
              ? {
                  cwd: opt.cwd,
                  mode: opt.mode ?? 'plan',
                  approved: Boolean(opt.approved),
                  verify: opt.verify,
                  commit: Boolean(opt.commit),
                  commitMessage: opt['commit-message'],
                  allowedTools: opt['allowed-tools'],
                  maxTurns: opt['max-turns'] ? Number(opt['max-turns']) : undefined
                }
              : undefined
          })
        );
        break;
      case 'task:list':
        print(svc.listTasks(opt.project, opt.status).map((t) => ({ id: t.id, title: t.title, status: t.status, attempts: t.attempts })));
        break;
      case 'task:show':
        print(svc.getTask(require_('task')));
        break;
      case 'task:cancel': {
        const r = svc.cancelTask(require_('task'));
        print(r);
        if (!r.ok) process.exit(2);
        break;
      }
      case 'task:approve':
        print(svc.approveTask(require_('task')));
        break;
      case 'task:run': {
        const r = await svc.runTask(require_('task'));
        print(r);
        if (!r.ok) process.exit(2);
        break;
      }

      /* handoff */
      case 'handoff:': {
        const r = await svc.handoff({
          project: require_('project'),
          from: require_('from'),
          to: require_('to'),
          title: opt.title,
          requirement: opt.requirement ?? '',
          artifact: opt.artifact ?? '',
          context: opt.context,
          constraints: opt.constraints
        });
        print(r);
        if (!r.ok) process.exit(2);
        break;
      }

      /* workflows */
      case 'workflow:create': {
        const fs = await import('node:fs');
        const spec = JSON.parse(fs.readFileSync(require_('spec-file'), 'utf8'));
        print(svc.createWorkflow({ project: require_('project'), name: require_('name'), spec }));
        break;
      }
      case 'workflow:list':
        print(svc.listWorkflows(opt.project).map((w) => ({ id: w.id, name: w.name, status: w.status, cursor: w.cursor })));
        break;
      case 'workflow:run': {
        const r = await svc.runWorkflow(require_('workflow'));
        print(r);
        if (!r.ok) process.exit(2);
        break;
      }
      case 'workflow:pause':
        print(svc.setWorkflowStatus(require_('workflow'), 'paused'));
        break;

      /* 管理员入口（本地可信） */
      case 'operator:init': {
        const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
        const { randomBytes } = await import('node:crypto');
        const dir = `${process.env.HOME}/.openclaw/jarvis`;
        const file = operatorKeyPath(process.env.HOME);
        mkdirSync(dir, { recursive: true });
        if (existsSync(file) && !opt.force) {
          fail('管理员密钥已存在；如需重建请加 --force');
        }
        writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
        print({ ok: true, key: file, note: '此密钥仅用于本地签发审批，不要提交到仓库' });
        break;
      }
      case 'verify-profile:add': {
        assertOperator(operatorKeyPath(process.env.HOME));
        const argv = opt.argv ? JSON.parse(opt.argv) : [];
        print(svc.createVerifyProfile({
          project: require_('project'),
          name: require_('name'),
          program: require_('program'),
          argv,
          cwd: opt.cwd,
          timeoutMs: opt.timeout ? Number(opt.timeout) : undefined
        }));
        break;
      }
      case 'verify-profile:list':
        print(svc.listVerifyProfiles(opt.project));
        break;
      case 'approve:': {
        assertOperator(operatorKeyPath(process.env.HOME));
        print(svc.issueApproval({ task: require_('task'), ttlHours: opt.ttl ? Number(opt.ttl) : 24 }));
        break;
      }
      case 'approval:list':
        print(svc.listApprovals(require_('task')));
        break;

      /* 自检 */
      case 'doctor:': {
        const { runDoctor } = await import('./doctor.mjs');
        const r = await runDoctor();
        if (asJson) print(r);
        else {
          for (const c of r.checks) console.log(`${c.status.padEnd(5)} ${c.name.padEnd(20)} ${c.detail}`);
          console.log('\n' + JSON.stringify(r.summary));
        }
        if (!r.ok) process.exit(2);
        break;
      }

      /* settings */
      case 'config:notify':
        print(svc.setSetting('notify_target', require_('target')));
        break;
      case 'config:show':
        print({ notify_target: svc.getSetting('notify_target') });
        break;

      /* models */
      case 'models:': {
        const models = await oc.listModels(opt.provider);
        print(models);
        break;
      }

      /* status */
      case 'status:':
        print(svc.projectStatus(require_('project')));
        break;

      default:
        fail(`未知命令: ${argv.join(' ')}`, {
          usage: [
            'project create --name <名称> [--slug <slug>]',
            'project list | show --project <ref> | pause | resume',
            'agent create --project <ref> --name <n> --model <provider/model> [--role <文本>] [--role-file <路径>]',
            'agent list [--project <ref>] | role | model | pause | resume',
            'conv create --agent <ref> [--title <t>] | conv list --agent <ref>',
            'talk --agent <ref> --message <文本> [--conversation <id>] [--session-key <k>]',
            'task create --project <ref> --title <t> [--input <文本>] [--agent <ref>] [--needs-approval]',
            'task list [--project <ref>] [--status <s>] | task show --task <id> | task approve --task <id> | task run --task <id> | task cancel --task <id>',
            'handoff --project <ref> --from <agent> --to <agent> --requirement <文本> [--artifact <文本>] [--context <文本>] [--constraints <文本>]',
            'workflow create --project <ref> --name <n> --spec-file <json>',
            'workflow run --workflow <id|name> | workflow list [--project <ref>] | workflow pause --workflow <id>',
            'operator init [--force]     # 生成本地管理员密钥（审批用）',
            'verify-profile add --project <ref> --name <n> --program <exe> [--argv <json>] [--cwd <dir>] [--timeout ms]',
            'verify-profile list [--project <ref>]',
            'approve --task <id> [--ttl 24]   # 本地管理员签发审批（Agent 无法调用）',
            'approval list --task <id>',
            'doctor                      # 环境自检（PASS/WARN/FAIL）',
            'config notify --target <feishu chat_id> | config show',
            'models [--provider <id>]',
            'status --project <ref>'
          ]
        });
    }
  } catch (err) {
    fail(err.message);
  }
}

main();
