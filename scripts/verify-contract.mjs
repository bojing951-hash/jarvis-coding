#!/usr/bin/env node
/**
 * 冻结验收契约完整性检查（跨平台，CI 与本地同源）。
 *
 * 只读校验，不修改契约。任何一项不一致都以非零退出码失败，
 * 防止契约被格式化、转写或静默替换后仍然通过门禁。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = resolve(ROOT, 'docs/contracts/p0-sec-01-ac-v1.0.md');
const MANIFEST = resolve(ROOT, 'docs/contracts/p0-sec-01-ac-v1.0.manifest.json');

const EXPECTED_SHA256 = 'af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0';
const EXPECTED_BYTES = 21297;

const bytes = readFileSync(CONTRACT);
const text = bytes.toString('utf8');
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

const actual = {
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  ac: (text.match(/^## AC-\d+/gm) ?? []).length,
  e2e: (text.match(/^## E2E-\d+/gm) ?? []).length,
  ev: (text.match(/^\| EV-\d+/gm) ?? []).length
};

const checks = [
  ['contract sha256', actual.sha256, EXPECTED_SHA256],
  ['contract bytes', actual.bytes, EXPECTED_BYTES],
  ['manifest sha256', manifest.sha256, EXPECTED_SHA256],
  ['manifest bytes', manifest.bytes, EXPECTED_BYTES],
  ['manifest status', manifest.status, 'FROZEN_VERIFIED'],
  ['manifest ac_count', manifest.ac_count, actual.ac],
  ['manifest e2e_count', manifest.e2e_count, actual.e2e],
  ['manifest ev_count', manifest.ev_count, actual.ev]
];

let failed = false;
for (const [name, value, expected] of checks) {
  const ok = value === expected;
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${value}${ok ? '' : ` (expected ${expected})`}`);
}

if (failed) {
  console.error('contract integrity FAILED');
  process.exit(1);
}
console.log(
  `contract integrity OK: ${actual.bytes} bytes, sha256 ${actual.sha256}, AC=${actual.ac}, E2E=${actual.e2e}, EV=${actual.ev}`
);
