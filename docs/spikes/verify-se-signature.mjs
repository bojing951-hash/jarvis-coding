#!/usr/bin/env node
/**
 * 独立验证 Secure Enclave 实验签名（不是生产代码）。
 *
 * 用法：
 *   node verify-se-signature.mjs <pub-raw-64> <payload> <signature-b64>
 *
 * 说明：CryptoKit 的 publicKey.rawRepresentation 是 64 bytes（X||Y），
 * 需要补 P-256 SPKI 前缀和 0x04 未压缩点前缀后再交给 Node crypto。
 */
import { readFileSync } from 'node:fs';
import { createPublicKey, createVerify } from 'node:crypto';

const [pubPath, payloadPath, sigPath] = process.argv.slice(2);
if (!pubPath || !payloadPath || !sigPath) {
  console.error('usage: node verify-se-signature.mjs <pub-raw-64> <payload> <signature-b64>');
  process.exit(2);
}

const raw = readFileSync(pubPath);
if (raw.length !== 64) {
  console.error(`expected 64-byte raw public key, got ${raw.length}`);
  process.exit(2);
}

const spkiPrefix = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d03010703420004',
  'hex'
);
const publicKey = createPublicKey({
  key: Buffer.concat([spkiPrefix, raw]),
  format: 'der',
  type: 'spki'
});

const payload = readFileSync(payloadPath);
const signature = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64');
const valid = createVerify('sha256').update(payload).verify(publicKey, signature);

const tampered = Buffer.from(payload.toString('utf8').replace(/abc123/, 'tampered'));
const tamperedValid =
  tampered.equals(payload)
    ? null
    : createVerify('sha256').update(tampered).verify(publicKey, signature);

console.log(JSON.stringify({ valid, tamperedValid, signatureBytes: signature.length }));
process.exit(valid ? 0 : 1);
