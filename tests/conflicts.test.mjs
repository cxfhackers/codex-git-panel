import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { git, snapshot, mutate } from '../server/git.mjs';
import { conflictPreview, suggestConflict, applyConflict } from '../server/conflicts.mjs';
import { conflictParts, mergeChoices, hasConflictMarkers } from '../src/conflicts.js';
async function fixture(t, { path = 'file.js', newline = '\n', binary = false, deleted = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'git-panel-conflict-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']); await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']);
  const value = (first, last) => binary ? Buffer.from([0, first, last]) : [`const mode = ${first};`, 'const middle = 1;', 'const stable = 2;', 'const padding = 3;', `const added = ${last};`, ''].join(newline);
  await writeFile(join(root, path), value(0, 0)); await writeFile(join(root, 'keep.txt'), 'original\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  await git(root, ['switch', '-c', 'incoming']);
  if (deleted) await git(root, ['rm', '--', path]); else { await writeFile(join(root, path), value(20, 42)); await git(root, ['add', '.']); }
  await git(root, ['commit', '-m', 'incoming']); await git(root, ['switch', 'main']);
  await writeFile(join(root, path), value(10, 0)); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'current']);
  await assert.rejects(git(root, ['merge', '--no-edit', 'incoming']));
  return { root, path };
}
function args(preview, content, deleted = false) { return { path: preview.path, token: preview.token, revision: preview.state.revision, content, deleted }; }
test('three-way preview preserves independent edits; block choices only replace conflicts', async t => {
  const { root, path } = await fixture(t), before = await snapshot(root), preview = await conflictPreview(root, path, before.revision);
  assert.equal(preview.count, 1); assert.equal(preview.labels.left, '当前分支'); assert.equal(preview.versions.base.text.includes('mode = 0'), true);
  assert.match(preview.automatic, /added = 42/); assert.equal((await snapshot(root)).revision, before.revision);
  const parts = conflictParts(preview.automatic), block = parts.find(p => p.index === 0);
  assert.match(block.left, /mode = 10/); assert.match(block.right, /mode = 20/);
  assert.equal(mergeChoices(parts, {}), preview.automatic);
  const result = mergeChoices(parts, { 0: block.left }); assert.equal(hasConflictMarkers(result), false); assert.match(result, /added = 42/);
});
test('AI uses actual three-way blocks without mutation and cannot alter nonconflicting code', async t => {
  const { root, path } = await fixture(t), preview = await conflictPreview(root, path);
  const result = await suggestConflict(root, preview.state, args(preview, ''), async prompt => {
    assert.match(prompt, /mode = 10/); assert.match(prompt, /mode = 20/); assert.match(prompt, /mode = 0/);
    return { explanation: '保留兼容的两项功能', warnings: ['核对业务优先级'], resolutions: [{ index: 0, content: 'const mode = 30;\n' }] };
  });
  assert.match(result.content, /mode = 30/); assert.match(result.content, /added = 42/); assert.equal(result.source, 'ai');
  assert.equal((await snapshot(root)).revision, preview.state.revision); assert.equal(await readFile(join(root, path), 'utf8'), preview.work);
  for (const resolutions of [[], [{ index: 5, content: '' }], [{ index: 0, content: '<<<<<<< leftover\n' }]]) {
    await assert.rejects(suggestConflict(root, preview.state, args(preview, ''), async () => ({ explanation: '', warnings: [], resolutions })), /格式|无效/);
  }
});
test('applying reviewed result stages only the conflict and saves durable original; no commit', async t => {
  const { root, path } = await fixture(t, { path: ':(glob) file.js' });
  await writeFile(join(root, 'keep.txt'), 'staged\n'); await git(root, ['add', '--', 'keep.txt']); await writeFile(join(root, 'keep.txt'), 'unstaged\n'); await writeFile(join(root, 'local.txt'), 'do not submit\n');
  const staged = await git(root, ['show', ':keep.txt']), preview = await conflictPreview(root, path);
  const content = mergeChoices(conflictParts(preview.automatic), { 0: 'const mode = 30;\n' });
  const result = await mutate(root, 'conflict-apply', args(preview, content));
  assert.equal(result.status, 'success'); assert.equal(result.state.head, preview.state.head); assert.equal(result.state.operation.type, 'merge');
  assert.equal(result.state.files.find(f => f.path === path).conflict, false); assert.equal(await git(root, ['show', ':keep.txt']), staged);
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'unstaged\n'); assert.equal(await readFile(join(root, 'local.txt'), 'utf8'), 'do not submit\n');
  assert.equal(JSON.parse(await readFile(join(result.backup, 'before.json'), 'utf8')).work, preview.work);
});
test('stale drafts and AI results are rejected, including external index-stage changes', async t => {
  const { root, path } = await fixture(t), preview = await conflictPreview(root, path);
  await assert.rejects(suggestConflict(root, preview.state, args(preview, ''), async () => { await writeFile(join(root, path), 'externally edited\n'); return { explanation: '', warnings: [], resolutions: [{ index: 0, content: 'const mode = 10;\n' }] }; }), /已变化/);
  await assert.rejects(mutate(root, 'conflict-apply', args(preview, 'replacement\n')), /已变化/);
  assert.equal(await readFile(join(root, path), 'utf8'), 'externally edited\n');
  const fresh = await conflictPreview(root, path);
  await assert.rejects(applyConflict(root, fresh.state, { ...args(fresh, 'replacement\n'), token: '0'.repeat(64) }), /已变化/);
  await assert.rejects(applyConflict(root, fresh.state, args(fresh, '<<<<<<< unresolved\n')), /标记/);
  const fields = (await git(root, ['ls-files', '-u', '--', path])).trim().split('\n').at(-1).split(/[\t ]/);
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'update-index', '--index-info']);
    child.on('error', reject); child.on('close', code => code ? reject(new Error('fixture index update failed')) : resolve());
    child.stdin.end(`${fields[0]} ${fields[1]} 1\t${path}\n`);
  });
  await assert.rejects(mutate(root, 'conflict-apply', args(fresh, 'replacement\n')), /已变化/);
  assert.equal(await readFile(join(root, path), 'utf8'), 'externally edited\n');
});
test('delete/modify conflict distinguishes deletion from empty file and supports reviewed deletion', async t => {
  const { root, path } = await fixture(t, { deleted: true }), preview = await conflictPreview(root, path);
  assert.equal(preview.versions.left.exists, true); assert.equal(preview.versions.right.exists, false); assert.equal(preview.canAuto, false);
  const result = await mutate(root, 'conflict-apply', args(preview, '', true));
  assert.equal(result.state.files.find(f => f.path === path).code, 'D '); await assert.rejects(readFile(join(root, path)), /ENOENT/);
});
test('binary conflict cannot be coerced to text and symlink worktrees cannot escape repository', async t => {
  const { root, path } = await fixture(t, { binary: true }), preview = await conflictPreview(root, path);
  assert.equal(preview.supported, false); const original = await readFile(join(root, path));
  await assert.rejects(mutate(root, 'conflict-apply', args(preview, 'replacement')), /二进制/); assert.deepEqual(await readFile(join(root, path)), original);
  const outside = await mkdtemp(join(tmpdir(), 'git-panel-conflict-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'keep'), 'outside\n'); await rm(join(root, path)); await symlink(join(outside, 'keep'), join(root, path));
  await assert.rejects(conflictPreview(root, path), /符号链接/); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside\n');
});
test('CRLF and executable mode survive result application', async t => {
  const { root, path } = await fixture(t, { newline: '\r\n' }); await chmod(join(root, path), 0o755);
  const preview = await conflictPreview(root, path), content = 'const mode = 30;\nconst added = 42;\n';
  await mutate(root, 'conflict-apply', args(preview, content));
  assert.equal(await readFile(join(root, path), 'utf8'), content.replaceAll('\n', '\r\n')); assert.equal((await lstat(join(root, path))).mode & 0o111, 0o111);
});
test('rebase labels sides by their actual Git meaning', async t => {
  const { root, path } = await fixture(t); await git(root, ['merge', '--abort']);
  await assert.rejects(git(root, ['rebase', 'incoming']));
  const preview = await conflictPreview(root, path); assert.equal(preview.labels.left, '已更新的基础分支'); assert.equal(preview.labels.right, '正在重放的本地提交');
  assert.match(preview.versions.left.text, /mode = 20/); assert.match(preview.versions.right.text, /mode = 10/);
});
test('restored local edits use distinct side labels and remain uncommitted after resolution', async t => {
  const { root, path } = await fixture(t); await git(root, ['merge', '--abort']);
  await writeFile(join(root, path), 'const mode = 30;\n');
  let before = await snapshot(root);
  const result = await mutate(root, 'merge', { revision: before.revision, ref: 'refs/heads/incoming', targetOid: (await git(root, ['rev-parse', 'incoming'])).trim() });
  assert.equal(result.status, 'conflict');
  let preview = await conflictPreview(root, path);
  await mutate(root, 'conflict-apply', args(preview, preview.versions.right.text));
  before = await snapshot(root);
  const restored = await mutate(root, 'merge-continue', { revision: before.revision }); assert.equal(restored.status, 'restore-conflict');
  preview = await conflictPreview(root, path); assert.equal(preview.labels.left, '更新后的分支'); assert.equal(preview.labels.right, '自动保存的本地改动');
  const applied = await mutate(root, 'conflict-apply', args(preview, 'const mode = 30;\n'));
  const finished = await mutate(root, 'restore-finish', { revision: applied.state.revision });
  assert.equal(finished.state.operation, null); assert.equal(finished.state.head, applied.state.head); assert.equal(finished.state.files.find(f => f.path === path).staged, false);
  assert.equal(await readFile(join(root, path), 'utf8'), 'const mode = 30;\n');
});
