/**
 * 真实 Docker 验证/审计隔离测试。
 * CI 无执行器镜像时显式 skip；本机真实 Docker 必须执行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DOCKER = process.env.JARVIS_DOCKER_BIN || '/Applications/Docker.app/Contents/Resources/bin/docker';
const IMAGE = process.env.JARVIS_EXECUTOR_IMAGE || 'jarvis-executor:2.1.104';

let hasImage = false;
try {
  execFileSync(DOCKER, ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 20_000 });
  hasImage = true;
} catch {}

const iso = await import('../src/isolation.mjs');

test('Docker 验证容器实际执行并返回结果', { skip: hasImage ? false : '执行器镜像不存在（CI 环境）' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-verify-'));
  const r = await iso.runInWorkdir({
    workdir: dir,
    program: 'node',
    args: ['-e', 'console.log("VERIFY_OK")'],
    image: IMAGE
  });
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /VERIFY_OK/);
});

test('Docker 审计/验证只读挂载阻止写入', { skip: hasImage ? false : '执行器镜像不存在（CI 环境）' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-ro-'));
  const r = await iso.runInWorkdir({
    workdir: dir,
    program: 'node',
    args: ['-e', 'require("fs").writeFileSync("/work/should-fail.txt","x")'],
    image: IMAGE,
    readOnly: true
  });
  assert.notEqual(r.exitCode, 0, '只读挂载下写入必须失败');
  assert.match(r.output, /EROFS|permission|read-only|EACCES/i);
});
