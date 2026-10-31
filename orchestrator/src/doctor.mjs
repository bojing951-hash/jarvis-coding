/**
 * 环境自检：一次运行回答「现在这套系统到底能不能用」。
 * 每一项都实际探测，不做假设。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import * as oc from './oc.mjs';
import * as ex from './executor.mjs';
import { db } from './service.mjs';

const HOME = homedir();

function sh(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, out: (stdout || '') + (stderr || '') });
    });
  });
}

const check = (name, status, detail) => ({ name, status, detail });

export async function runDoctor() {
  const checks = [];

  // 1. OpenClaw CLI
  const ver = await sh(oc.openclawBin(), ['--version'], 30_000);
  checks.push(
    ver.code === 0 && /OpenClaw/.test(ver.out)
      ? check('openclaw', 'PASS', ver.out.trim().split('\n')[0])
      : check('openclaw', 'FAIL', ver.out.slice(0, 200))
  );

  // 2. Gateway
  const gw = await sh(oc.openclawBin(), ['gateway', 'status'], 60_000);
  const gwRunning = /Runtime:\s*running/i.test(gw.out);
  const gwLoopback = /bind=loopback/i.test(gw.out);
  checks.push(
    gwRunning && gwLoopback
      ? check('gateway', 'PASS', 'loopback 运行中')
      : check('gateway', 'FAIL', gwRunning ? '未绑定 loopback' : '未运行')
  );

  // 3. 飞书通道
  const ch = await sh(oc.openclawBin(), ['channels', 'status', '--probe'], 120_000);
  checks.push(
    /feishu[^\n]*connected/i.test(ch.out)
      ? check('feishu', 'PASS', 'connected / works')
      : check('feishu', 'FAIL', ch.out.slice(-200))
  );

  // 4. 模型 provider
  let models = [];
  try {
    models = await oc.listModels();
  } catch {}
  const byProvider = models.reduce((acc, m) => {
    acc[m.provider] = (acc[m.provider] ?? 0) + 1;
    return acc;
  }, {});
  const providerNames = Object.keys(byProvider);
  checks.push(
    providerNames.length
      ? check('providers', providerNames.length > 1 ? 'PASS' : 'WARN', JSON.stringify(byProvider))
      : check('providers', 'FAIL', '没有可用模型（缺凭据？）')
  );

  // 5. 状态库
  try {
    const d = db();
    const counts = {
      projects: d.prepare('SELECT COUNT(*) n FROM projects').get().n,
      agents: d.prepare('SELECT COUNT(*) n FROM agents').get().n,
      tasks: d.prepare('SELECT COUNT(*) n FROM tasks').get().n,
      workflows: d.prepare('SELECT COUNT(*) n FROM workflows').get().n
    };
    const stale = d.prepare("SELECT COUNT(*) n FROM tasks WHERE status='running'").get().n;
    checks.push(check('state', 'PASS', `${JSON.stringify(counts)}${stale ? ` · ${stale} 个 running 任务` : ''}`));

    // 6. Agent 一致性：库里记的 OpenClaw agent 是否真实存在
    const live = await oc.listAgents();
    const liveIds = new Set(live.map((a) => a.id));
    const missing = d.prepare('SELECT name, openclaw_agent_id FROM agents').all()
      .filter((a) => !liveIds.has(a.openclaw_agent_id));
    checks.push(
      missing.length === 0
        ? check('agent-consistency', 'PASS', '全部 Agent 在 OpenClaw 中存在')
        : check('agent-consistency', 'WARN', `缺失: ${missing.map((m) => m.name).join(', ')}`)
    );
  } catch (e) {
    checks.push(check('state', 'FAIL', e.message.slice(0, 200)));
  }

  // 7. 执行器
  const exStatus = await ex.executorStatus();
  checks.push(
    exStatus.ok
      ? check('executor', 'PASS', `Claude Code ${exStatus.version.split('\n')[0]}`)
      : check('executor', 'WARN', 'Claude Code 不可用')
  );

  // 8. 通知目标
  try {
    const target = db().prepare("SELECT value FROM settings WHERE key='notify_target'").get()?.value;
    checks.push(
      target ? check('notify', 'PASS', target) : check('notify', 'WARN', '未配置 notify_target，工作流不会推送')
    );
  } catch {
    checks.push(check('notify', 'WARN', '未配置'));
  }

  // 9. 安全姿态（读配置）
  const cfgPath = join(HOME, '.openclaw/openclaw.json');
  let posture = null;
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse((await import('node:fs')).readFileSync(cfgPath, 'utf8'));
    posture = {
      profile: cfg.tools?.profile,
      exec: cfg.tools?.exec?.mode,
      workspaceOnly: cfg.tools?.fs?.workspaceOnly,
      codeMode: cfg.tools?.codeMode,
      dmPolicy: cfg.channels?.feishu?.dmPolicy,
      groupPolicy: cfg.channels?.feishu?.groupPolicy
    };
    const ok =
      posture.exec === 'deny' &&
      posture.workspaceOnly === true &&
      posture.codeMode === false &&
      posture.dmPolicy === 'allowlist' &&
      posture.groupPolicy === 'disabled';
    checks.push(check('security', ok ? 'PASS' : 'WARN', JSON.stringify(posture)));
  } else {
    checks.push(check('security', 'FAIL', '找不到 openclaw.json'));
  }

  const summary = checks.reduce((acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc), {});
  return { checks, summary, ok: !checks.some((c) => c.status === 'FAIL') };
}
