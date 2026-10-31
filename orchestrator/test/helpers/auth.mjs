/**
 * 测试用审批签名器：在临时 HOME 下生成 P-256 密钥并安装 SPKI 公钥。
 *
 * 仅用于测试准备。生产信任根固定在 ~/.openclaw/jarvis/auth/pubkey.der，
 * 不允许通过环境变量替换。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, createSign } from 'node:crypto';

export function installTestAuthKey(home) {
  const dir = join(home, '.openclaw/jarvis/auth');
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(join(dir, 'pubkey.der'), publicKey.export({ type: 'spki', format: 'der' }));

  const sign = (payload) => {
    const signer = createSign('sha256');
    signer.update(payload);
    return signer.sign(privateKey).toString('base64');
  };

  const proofFor = (challenge) => ({
    nonce: challenge.nonce,
    payload: challenge.payload,
    signatureB64: sign(challenge.payload)
  });

  return {
    sign,
    proofFor,
    issueApproval(svc, task, extra = {}) {
      const challenge = svc.createAuthChallenge(task);
      return svc.issueApproval({ task, ...extra, proof: proofFor(challenge) });
    },
    createVerifyProfile(svc, content, extra = {}) {
      const challenge = svc.createContentChallenge(content);
      return svc.createVerifyProfile({
        project: content.project,
        name: content.name,
        program: content.program,
        argv: content.argv,
        cwd: content.cwd,
        timeoutMs: content.timeout_ms,
        ...extra,
        proof: proofFor(challenge)
      });
    }
  };
}
