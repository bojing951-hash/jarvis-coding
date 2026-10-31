import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose } from '../src/oc.mjs';

test('解析对象输出（tail 有额外日志行）', () => {
  const raw = '{"ok":true,"result":{"x":1}}\n[state] clean-close\n';
  assert.deepEqual(parseJsonLoose(raw), { ok: true, result: { x: 1 } });
});

test('解析顶层数组（agents list 的实际返回）', () => {
  const raw = '[{"id":"a"},{"id":"b"}]\n[state/agent-db] done\n';
  const parsed = parseJsonLoose(raw);
  assert.ok(Array.isArray(parsed), '顶层数组必须解析为数组');
  assert.equal(parsed.length, 2);
});

test('数组优先于内部对象', () => {
  const raw = 'noise\n[{"id":"x"}]\n';
  assert.equal(parseJsonLoose(raw)[0].id, 'x');
});

test('无 JSON 时返回 null', () => {
  assert.equal(parseJsonLoose('no json here'), null);
  assert.equal(parseJsonLoose(''), null);
});
