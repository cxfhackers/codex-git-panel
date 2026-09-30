import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../server/git.mjs';
import { readComparison } from '../server/editor-compare.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-panel-inline-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'QA']);
  await git(root, ['config', 'user.email', 'qa@example.test']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

test('comparison reads HEAD and latest working copy without changing a partially staged file', async t => {
  const root = await fixture(t), path = '中文: [file].xml';
  await writeFile(join(root, path), '<base/>\r\n');
  await git(root, ['add', '--', path]); await git(root, ['commit', '-m', 'base']);
  await writeFile(join(root, path), '<staged/>\r\n'); await git(root, ['add', '--', path]);
  await writeFile(join(root, path), '<local/>\r\n');
  const before = await git(root, ['write-tree']);
  const result = await readComparison(root, path);
  assert.equal(result.original, '<base/>\r\n');
  assert.equal(result.content, '<local/>\r\n');
  assert.equal(result.originalPath, path); assert.equal(result.crlf, true);
  assert.equal(await git(root, ['write-tree']), before);
});

test('comparison follows staged rename to the original HEAD path', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'before.txt'), 'before\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  await git(root, ['mv', 'before.txt', 'after.txt']);
  const result = await readComparison(root, 'after.txt');
  assert.equal(result.original, 'before\n'); assert.equal(result.originalPath, 'before.txt');
});

test('comparison supports unborn and untracked files while preserving UTF-8 BOM', async t => {
  const root = await fixture(t), path = '-:new.txt';
  await writeFile(join(root, path), '\ufeff新文件\n');
  const result = await readComparison(root, path);
  assert.equal(result.original, ''); assert.equal(result.content, '\ufeff新文件\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  await writeFile(join(root, 'other.txt'), 'other\n');
  assert.equal((await readComparison(root, 'other.txt')).original, '');
});

test('comparison refuses binary or oversized historical content', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'binary.txt'), Buffer.from([0, 255]));
  await writeFile(join(root, 'large.txt'), 'x'.repeat(524289));
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  await writeFile(join(root, 'binary.txt'), 'text\n'); await writeFile(join(root, 'large.txt'), 'small\n');
  await assert.rejects(readComparison(root, 'binary.txt'), /二进制/);
  await assert.rejects(readComparison(root, 'large.txt'), /512 KiB/);
});
