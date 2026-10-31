/**
 * FIX3 安全回归：签名审批、挑战防重放、Docker 未知状态、审计只读挂载。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const tmp = mkdtempSync(join(tmpdir(), 'jarvis-fix3-'));
process.env.JARVIS_HOME = tmp;
process.env.JARVIS_DB = join(tmp, 'state.db');

const sec = await import('../src/security.mjs');
const svc = await import('../src/service.mjs');

const gitRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'x');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return g('rev-parse', 'HEAD').trim();
};

/* ------------------------- 签名验签（独立于助手退出码） --------------------- */

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyPath = join(tmp, 'pubkey.der');
  writeFileSync(keyPath, spki);
  return { privateKey, keyPath };
}

test('FIX3-A 合法签名通过服务端验签', () => {
  const { privateKey, keyPath } = makeKeyPair();
  const payload = sec.buildApprovalPayload({ taskId: 'tsk_1', digest: 'abc', nonce: 'n1', expiresAt: '2030-01-01T00:00:00Z' });
  const signer = createSign('sha256');
  signer.update(payload);
  const sig = signer.sign(privateKey).toString('base64');
  const r = sec.verifyApprovalSignature({ payload, signatureB64: sig, pubkeyDerPath: keyPath });
  assert.equal(r.ok, true, r.error);
});

test('FIX3-A 载荷被篡改则验签失败', () => {
  const { privateKey, keyPath } = makeKeyPair();
  const payload = sec.buildApprovalPayload({ taskId: 'tsk_1', digest: 'abc', nonce: 'n1', expiresAt: '2030-01-01T00:00:00Z' });
  const signer = createSign('sha256');
  signer.update(payload);
  const sig = signer.sign(privateKey).toString('base64');
  const tampered = Buffer.from(payload.toString().replace('tsk_1', 'tsk_2'));
  const r = sec.verifyApprovalSignature({ payload: tampered, signatureB64: sig, pubkeyDerPath: keyPath });
  assert.equal(r.ok, false);
});

test('FIX3-A 缺少公钥时拒绝', () => {
  const r = sec.verifyApprovalSignature({
    payload: Buffer.from('x'),
    signatureB64: 'AAAA',
    pubkeyDerPath: join(tmp, 'missing.der')
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少审批公钥/);
});

test('FIX3-A 助手被替换（退出码 0 但无有效签名）无法通过', () => {
  const fake = join(tmp, 'fake-signer.sh');
  writeFileSync(fake, '#!/bin/sh\necho "ZmFrZQ=="\nexit 0\n');
  chmodSync(fake, 0o755);
  const { keyPath } = makeKeyPair();
  const payload = sec.buildApprovalPayload({ taskId: 't', digest: 'd', nonce: 'n', expiresAt: '2030-01-01T00:00:00Z' });
  const r = sec.verifyApprovalSignature({ payload, signatureB64: 'ZmFrZQ==', pubkeyDerPath: keyPath });
  assert.equal(r.ok, false, '伪造的 base64 不得通过验签');
});

/* ------------------------------- 挑战防重放 -------------------------------- */

function seedTask() {
  const slug = `f3-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const p = svc.createProject({ name: 'FIX3', slug });
  const head = gitRepo(join(p.dir, 'repo'));
  return svc.createTask({
    project: p.id,
    title: 'FIX3 任务',
    input: 'x',
    kind: 'executor',
    executor: 'claude-code',
    executorConfig: { mode: 'acceptEdits', repo: 'repo', base_commit: head }
  });
}

test('FIX3-A 挑战只能消耗一次', () => {
  const t = seedTask();
  const c = svc.createAuthChallenge(t.id);
  assert.equal(svc.consumeAuthChallenge(c.nonce, c.task_id, c.digest), true);
  assert.equal(svc.consumeAuthChallenge(c.nonce, c.task_id, c.digest), false, '重放必须失败');
});

test('FIX3-A 挑战与任务绑定，换任务不可用', () => {
  const a = seedTask();
  const b = seedTask();
  const c = svc.createAuthChallenge(a.id);
  assert.equal(svc.consumeAuthChallenge(c.nonce, b.id, c.digest), false);
});

/* ------------------------------- Docker 未知状态 ---------------------------- */

test('FIX3-E 未知容器状态不得判为已停止', async () => {
  const fake = join(tmp, 'docker-unknown.sh');
  writeFileSync(
    fake,
    `#!/bin/sh
case "$1" in
  info) echo 29.9.2; exit 0 ;;
  kill) exit 0 ;;
  inspect) echo "weird-state"; exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(fake, 0o755);
  process.env.JARVIS_DOCKER_BIN = fake;
  const iso = await import(`../src/isolation.mjs?u${Date.now()}`);
  const r = await iso.killContainer('jarvis-exec-x');
  assert.equal(r.confirmed, false);
  assert.equal(r.reason, 'unknown_container_state');
  delete process.env.JARVIS_DOCKER_BIN;
});

/* ------------------------------- 审计只读挂载 ------------------------------- */

test('FIX3-D 只读挂载真实阻止容器写入', () => {
  let out = '';
  try {
    out = execFileSync(
      '/Applications/Docker.app/Contents/Resources/bin/docker',
      [
        'run', '--rm', '--network', 'none', '--user', '1000:1000',
        '-v', `${tmp}:/work:ro`, '-w', '/work',
        '--entrypoint', 'sh', 'jarvis-executor:2.1.104', '-c',
        'echo x > /work/should-fail.txt 2>&1 || echo WRITE_BLOCKED'
      ],
      { encoding: 'utf8', timeout: 120000 }
    );
  } catch (e) {
    out = String(e.stdout || e.message);
  }
  assert.match(out, /WRITE_BLOCKED|Permission denied|Read-only/);
});
