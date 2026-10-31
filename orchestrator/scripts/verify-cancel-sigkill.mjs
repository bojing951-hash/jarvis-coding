#!/usr/bin/env node
/**
 * FIX3 真实场景验证（需要 Docker）：
 *  AC-18  忽略 SIGTERM 的容器：取消必须升级到 SIGKILL 并确认，否则如实报告未确认
 *  AC-20  跨进程重启：终态与状态在另一个进程里保持一致
 *
 * 运行：node orchestrator/scripts/verify-cancel-sigkill.mjs
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DOCKER = process.env.JARVIS_DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const NET = process.env.JARVIS_EXECUTOR_NETWORK || 'jarvis-internal';
const IMAGE = process.env.JARVIS_EXECUTOR_IMAGE || 'jarvis-executor:2.1.104';

const tmp = mkdtempSync(join(tmpdir(), 'f3-sigkill-'));
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');

const sh = (args, timeoutMs = 60_000) =>
  new Promise((r) => {
    execFile(DOCKER, args, { timeout: timeoutMs }, (e, so, se) =>
      r({ code: e?.code ?? 0, out: ((so || '') + (se || '')).trim() })
    );
  });

const results = [];
const record = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`);
};

async function main() {
  const svc = await import('../src/service.mjs');

  /* ---------------- AC-18：忽略 SIGTERM 的进程必须被 SIGKILL ---------------- */
  const execId = `exe_sigkill_${Date.now().toString(36)}`;
  const cname = `jarvis-exec-${execId}`;

  const started = await sh([
    'run', '-d', '--name', cname, '--network', NET,
    '--entrypoint', 'sh', IMAGE, '-c', 'trap "" TERM; sleep 300'
  ]);
  record('启动忽略 SIGTERM 的容器', started.code === 0, cname);

  const p = svc.createProject({ name: 'sigkill', slug: `f3-sigkill-${Date.now().toString(36)}` });
  const t = svc.createTask({ project: p.id, title: 'AC-18', input: 'x' });
  svc.updateTask(t.id, { status: 'running' });
  svc.db()
    .prepare("INSERT INTO executions (id,task_id,agent_id,status,model,session_key,started_at) VALUES (?,?,?,?,?,?,?)")
    .run(execId, t.id, null, 'running', 'test', '', new Date().toISOString());
  svc.db()
    .prepare("INSERT INTO execution_resources (id,execution_id,task_id,kind,name,state,started_at) VALUES (?,?,?,?,?,?,?)")
    .run(`res_${execId}`, execId, t.id, 'claude', cname, 'started', new Date().toISOString());

  const t0 = Date.now();
  const cancel = await svc.cancelTask(t.id);
  const elapsed = Date.now() - t0;

  const escalated = (cancel.results || []).some((r) => r.escalatedToSigkill || (r.containers || []).some((c) => c.escalated));
  record('取消升级到 SIGKILL', escalated === true, `${elapsed}ms`);
  record('取消结果确认为已终止', cancel.ok === true);

  const still = await sh(['inspect', cname, '--format', '{{.State.Status}}']);
  record('容器已停止（gone 或 exited）', /No such object|could not be found/i.test(still.out) || /exited|dead|removing/.test(still.out), still.out.slice(0, 40));

  const row = svc.getTask(t.id);
  record('任务状态为 cancelled', row.status === 'cancelled', row.status);

  /* ---------------- AC-20：跨进程重启后状态一致 ---------------- */
  const p2 = svc.createProject({ name: 'restart', slug: `f3-restart-${Date.now().toString(36)}` });
  const doneTask = svc.createTask({ project: p2.id, title: 'done-task', input: 'x' });
  svc.updateTask(doneTask.id, { status: 'done' });

  const probe = `
    process.env.JARVIS_HOME = ${JSON.stringify(tmp)};
    process.env.JARVIS_DB = ${JSON.stringify(process.env.JARVIS_DB)};
    const svc = await import('${new URL('../src/service.mjs', import.meta.url).href}');
    const t = svc.getTask(${JSON.stringify(doneTask.id)});
    const r = await svc.runTask(t.id);
    console.log(JSON.stringify({ status: t.status, blocked: r.blocked }));
  `;
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    out = String(e.stdout || e.message);
  }
  let parsed = null;
  try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch {}
  record('新进程读到终态且拒绝重复执行', parsed?.status === 'done' && parsed?.blocked === 'terminal_state', out.trim().slice(-80));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
