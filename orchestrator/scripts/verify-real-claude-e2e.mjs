#!/usr/bin/env node
/**
 * 真实 Docker + Claude Code + GLM 代理 + 真实 Secure Enclave 审批 的合法写入 E2E。
 *
 * 这是 AC-12 / E2E-03 的真实证据尝试；不使用模型替身。
 * - 临时 HOME/JARVIS_HOME/仓库，不触碰生产仓库或 main
 * - 临时 egress proxy 容器挂载临时 token 文件与生产 GLM key（只读）
 * - 需要用户完成一次 Touch ID / 系统密码
 *
 * 用法：
 *   JARVIS_E2E_HOME=/tmp/jarvis-real-e2e/home \
 *   JARVIS_E2E_KEY_DIR=$HOME/.openclaw/jarvis/auth \
 *   node orchestrator/scripts/verify-real-claude-e2e.mjs
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REAL_HOME = homedir();
const HOME_DIR = process.env.JARVIS_E2E_HOME || '/tmp/jarvis-real-e2e/home';
const KEY_DIR = process.env.JARVIS_E2E_KEY_DIR || join(REAL_HOME, '.openclaw/jarvis/auth');
const SIGNER = process.env.JARVIS_AUTH_SIGNER || join(REAL_HOME, '.openclaw/jarvis/bin/jarvis-auth');
const DOCKER = process.env.JARVIS_DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const PROXY_IMAGE = process.env.JARVIS_PROXY_IMAGE || 'jarvis-egress-proxy:1';
const EXECUTOR_IMAGE = process.env.JARVIS_EXECUTOR_IMAGE || 'jarvis-executor:2.1.104';
const NETWORK = process.env.JARVIS_EXECUTOR_NETWORK || 'jarvis-internal';
const GLM_KEY = process.env.JARVIS_GLM_KEY_FILE || join(REAL_HOME, '.openclaw/jarvis/proxy/glm.key');
const PROXY_NAME = `jarvis-proxy-real-e2e-${Date.now().toString(36)}`;

// HOME 被切到临时目录后，Docker CLI 会丢失 Docker Desktop context；显式固定 socket。
process.env.DOCKER_HOST = process.env.DOCKER_HOST || `unix://${join(REAL_HOME, '.docker/run/docker.sock')}`;
process.env.HOME = HOME_DIR;
process.env.JARVIS_HOME = join(HOME_DIR, 'jarvis');
process.env.JARVIS_DB = join(process.env.JARVIS_HOME, 'state.db');
process.env.JARVIS_AUTH_SIGNER = SIGNER;
process.env.JARVIS_PROXY_CONTAINER = PROXY_NAME;
process.env.JARVIS_EXECUTOR_IMAGE = EXECUTOR_IMAGE;
process.env.JARVIS_EXECUTOR_NETWORK = NETWORK;

const authDir = join(HOME_DIR, '.openclaw/jarvis/auth');
const runDir = join(process.env.JARVIS_HOME, 'run');
const proxyDir = join(process.env.JARVIS_HOME, 'proxy');
mkdirSync(authDir, { recursive: true });
mkdirSync(runDir, { recursive: true });
mkdirSync(proxyDir, { recursive: true });
mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });
for (const [file, mode] of [['approval.sekey', 0o600], ['pubkey.der', 0o644]]) {
  const src = join(KEY_DIR, file);
  if (!existsSync(src)) throw new Error(`missing SE key file: ${src}`);
  const dst = join(authDir, file);
  copyFileSync(src, dst);
  chmodSync(dst, mode);
}
writeFileSync(join(HOME_DIR, '.claude/settings.json'), JSON.stringify({
  env: { ANTHROPIC_MODEL: process.env.JARVIS_E2E_MODEL || 'glm-5.3' }
}));

const tokenFile = join(proxyDir, 'active-tokens.json');
writeFileSync(tokenFile, '{}', { mode: 0o600 });
const proxyCmd = [
  'run', '-d', '--rm', '--name', PROXY_NAME,
  '--network', 'bridge',
  '-v', `${tokenFile}:/run/secrets/model-tokens.json:ro`,
  '-v', `${GLM_KEY}:/run/secrets/glm.key:ro`,
  PROXY_IMAGE
];
execFileSync(DOCKER, proxyCmd, { encoding: 'utf8' });
execFileSync(DOCKER, ['network', 'connect', NETWORK, PROXY_NAME], { encoding: 'utf8' });

const cleanup = () => {
  try { execFileSync(DOCKER, ['rm', '-f', PROXY_NAME], { stdio: 'ignore' }); } catch {}
};
process.on('exit', cleanup);

const svc = await import('../src/service.mjs');
const sec = await import('../src/security.mjs');

try {
  const project = svc.createProject({ name: 'Real Claude E2E', slug: `real-claude-${Date.now().toString(36)}` });
  const repo = join(project.dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  try { git('init', '-q'); } catch {}
  writeFileSync(join(repo, 'README.md'), '# real claude e2e\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const base = git('rev-parse', 'HEAD').trim();

  const vpId = `vpr_real_${Date.now().toString(36)}`;
  const verifyArgv = [
    '-e',
    'const fs=require("fs");const s=fs.readFileSync("feature.txt","utf8").trim();if(s!=="HELLO_FROM_JARVIS"){console.error("BAD:"+s);process.exit(1)};console.log("FEATURE_OK")'
  ];
  svc.db()
    .prepare('INSERT INTO verify_profiles (id,project_id,name,program,argv,cwd,timeout_ms,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(vpId, project.id, 'feature-ok', 'node', JSON.stringify(verifyArgv), null, 300_000, 'e2e', new Date().toISOString());

  const task = svc.createTask({
    project: project.id,
    title: '真实 Claude Code 合法写入',
    input: 'Create a file named feature.txt in the current working directory. It must contain exactly one line: HELLO_FROM_JARVIS. Do not create or modify any other file.',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: {
      mode: 'acceptEdits',
      repo: 'repo',
      base_commit: base,
      commit: true,
      commit_paths: ['feature.txt'],
      verify_profile_id: vpId,
      timeout_ms: 600_000
    }
  });

  const challenge = svc.createAuthChallenge(task.id);
  const payloadPath = join(runDir, 'real-claude-payload.json');
  writeFileSync(payloadPath, challenge.payload, { mode: 0o600 });
  const signatureB64 = execFileSync(
    SIGNER,
    ['sign', payloadPath, challenge.reason.slice(0, 500)],
    { encoding: 'utf8', timeout: 180_000 }
  ).trim();
  const verified = sec.verifyApprovalSignature({ payload: challenge.payload, signatureB64 });
  if (!verified.ok) throw new Error(`signature verification failed: ${verified.error}`);
  const issued = svc.issueApproval({
    task: task.id,
    proof: { nonce: challenge.nonce, payload: challenge.payload, signatureB64 }
  });
  if (!issued.ok) throw new Error(`approval issuance failed: ${issued.error}`);

  const result = await svc.runTask(task.id);
  const latest = svc.getTask(task.id);
  const approval = svc.db().prepare('SELECT * FROM approvals WHERE task_id=?').get(task.id);
  const execution = svc.db().prepare('SELECT * FROM executions WHERE id=?').get(result.execution);
  let refSha = null;
  try {
    refSha = execFileSync('git', ['-C', repo, 'rev-parse', `refs/heads/jarvis/${task.id}`], { encoding: 'utf8' }).trim();
  } catch {}
  const changed = result.evidence?.worktree?.changed ?? [];

  const evidence = {
    task: task.id,
    approvalId: approval?.id,
    approvalExecutionId: approval?.execution_id,
    executionId: result.execution,
    executionStatus: execution?.status,
    taskStatus: latest.status,
    commitSha: result.commit?.sha ?? null,
    ref: result.commit?.ref ?? null,
    refVerified: result.commit?.refVerified ?? false,
    refMatchesCommit: Boolean(refSha && refSha === result.commit?.sha),
    verdict: result.verdict?.status ?? null,
    reasons: result.verdict?.reasons ?? [],
    changed,
    verify: result.verify ?? null,
    executorText: (result.text ?? '').slice(0, 500)
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (latest.status !== 'done' || result.verdict?.status !== 'done' || !result.commit?.sha || !result.commit?.refVerified) {
    process.exit(1);
  }
} finally {
  cleanup();
}
