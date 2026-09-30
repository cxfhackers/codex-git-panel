import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, snapshot } from '../server/git.mjs';
import { createShelf, listShelves, restoreShelf, shelfDiff } from '../server/shelves.mjs';

async function fixture(t, committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-panel-shelves-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'QA']); await git(root, ['config', 'user.email', 'qa@example.test']); await git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'app.txt'), 'one\ntwo\nthree\nfour\nfive\n'); await writeFile(join(root, 'other.txt'), 'other base\n');
  if (committed) { await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']); }
  return root;
}
async function shelve(root, paths, body = {}) { return createShelf(root, await snapshot(root), { paths, name: '测试搁置', groupId: 'feature', ...body }); }
async function restore(root, shelfId, body = {}) { return restoreShelf(root, await snapshot(root), { shelfId, ...body }); }

test('shelf roundtrip preserves selected partial staging and unrelated work/index', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'app.txt'), 'one staged\ntwo\nthree\nfour\nfive\n'); await git(root, ['add', 'app.txt']);
  await writeFile(join(root, 'app.txt'), 'one staged\ntwo\nthree\nfour\nfive working\n');
  await writeFile(join(root, 'other.txt'), 'other staged\n'); await git(root, ['add', 'other.txt']); await writeFile(join(root, 'other.txt'), 'other working\n');
  const before = await snapshot(root), cached = await git(root, ['diff', '--cached', '--binary']), unstaged = await git(root, ['diff', '--binary']);
  const created = await shelve(root, ['app.txt']);
  assert.equal(created.status, 'success'); assert.deepEqual((await snapshot(root)).files.map(file => file.path), ['other.txt']);
  assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other working\n'); assert.equal(await git(root, ['show', ':other.txt']), 'other staged\n');
  const listed = await listShelves(root); assert.equal(listed[0].id, created.shelf.id); assert.equal(listed[0].groupId, 'feature');
  const preview = await shelfDiff(root, created.shelf.id, 'app.txt'); assert.match(preview.patch, /five working/); assert.match(preview.patch, /a\/app\.txt/);
  const result = await restore(root, created.shelf.id);
  assert.equal(result.status, 'success'); assert.equal((await snapshot(root)).revision, before.revision);
  assert.equal(await git(root, ['diff', '--cached', '--binary']), cached); assert.equal(await git(root, ['diff', '--binary']), unstaged);
  assert.deepEqual((await listShelves(root))[0].restoredPaths, ['app.txt']); assert.equal((await git(root, ['stash', 'list'])).trim(), '');
});

test('new/deleted/binary/literal files roundtrip with partial restore and executable mode', async t => {
  const root = await fixture(t), special = '新 :[abc]*.txt';
  await writeFile(join(root, special), 'new 中文\n'); await chmod(join(root, special), 0o755);
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 5, 255, 13])); await rm(join(root, 'other.txt'));
  const created = await shelve(root, [special, 'binary.dat', 'other.txt']);
  assert.equal((await snapshot(root)).files.length, 0);
  let result = await restore(root, created.shelf.id, { paths: [special] }); assert.equal(result.status, 'success');
  assert.equal(await readFile(join(root, special), 'utf8'), 'new 中文\n'); assert.equal((await stat(join(root, special))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other base\n'); await assert.rejects(readFile(join(root, 'binary.dat')), { code: 'ENOENT' });
  result = await restore(root, created.shelf.id, { paths: ['binary.dat', 'other.txt'] });
  assert.equal(result.status, 'success'); assert.deepEqual(await readFile(join(root, 'binary.dat')), Buffer.from([0, 5, 255, 13])); await assert.rejects(readFile(join(root, 'other.txt')), { code: 'ENOENT' });
  assert.equal((await listShelves(root))[0].restoredPaths.length, 3);
});

test('staged rename restores both endpoints and index without including unrelated changes', async t => {
  const root = await fixture(t); await git(root, ['mv', 'app.txt', 'renamed.txt']); await writeFile(join(root, 'renamed.txt'), 'renamed work\n');
  await writeFile(join(root, 'other.txt'), 'unrelated\n');
  const before = await snapshot(root), result = await shelve(root, ['renamed.txt']);
  assert.equal((await snapshot(root)).files.length, 1); assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\n');
  await restore(root, result.shelf.id); assert.equal((await snapshot(root)).revision, before.revision);
});

test('nonoverlapping local and shelved edits merge in working tree and index', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'SHELF one\ntwo\nthree\nfour\nfive\n');
  const created = await shelve(root, ['app.txt']); await writeFile(join(root, 'app.txt'), 'one\ntwo\nthree\nfour\nLOCAL five\n');
  const result = await restore(root, created.shelf.id); assert.equal(result.status, 'success');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'SHELF one\ntwo\nthree\nfour\nLOCAL five\n');
  assert.equal(await git(root, ['show', ':app.txt']), 'one\ntwo\nthree\nfour\nfive\n');
});

test('overlapping restore previews three-way conflict without mutation and checks resolution token', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'SHELF\ntwo\nthree\nfour\nfive\n');
  const created = await shelve(root, ['app.txt']); await writeFile(join(root, 'app.txt'), 'LOCAL\ntwo\nthree\nfour\nfive\n');
  const before = await snapshot(root), result = await restore(root, created.shelf.id);
  assert.equal(result.status, 'conflict'); assert.equal(result.conflicts.length, 1); assert.match(result.conflicts[0].merged, /<<<<<<< 当前文件/);
  assert.equal((await snapshot(root)).revision, before.revision); assert.equal(result.conflicts[0].base, 'one\ntwo\nthree\nfour\nfive\n');
  await writeFile(join(root, 'app.txt'), 'new external\n');
  await assert.rejects(restore(root, created.shelf.id, { resolutions: [{ path: 'app.txt', token: result.conflicts[0].token, content: 'resolved\n' }] }), /外部修改/);
  const retry = await restore(root, created.shelf.id); const token = retry.conflicts[0].token;
  await assert.rejects(restore(root, created.shelf.id, { resolutions: [{ path: 'app.txt', token, content: retry.conflicts[0].merged }] }), /冲突标记/);
  assert.equal((await restore(root, created.shelf.id, { resolutions: [{ path: 'app.txt', token, content: 'resolved both\n' }] })).status, 'success');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'resolved both\n'); assert.equal((await listShelves(root)).length, 1);
});

test('binary add collision and delete/modify conflict require explicit choice', async t => {
  const root = await fixture(t); await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1])); await rm(join(root, 'other.txt'));
  const created = await shelve(root, ['binary.dat', 'other.txt']); await writeFile(join(root, 'binary.dat'), Buffer.from([0, 2])); await writeFile(join(root, 'other.txt'), 'local edit\n');
  const result = await restore(root, created.shelf.id); assert.equal(result.status, 'conflict'); assert.equal(result.conflicts.length, 2);
  assert.equal(result.conflicts.find(file => file.path === 'binary.dat').binary, true);
  await restore(root, created.shelf.id, { resolutions: result.conflicts.map(file => ({ path: file.path, token: file.token, choice: file.path === 'binary.dat' ? 'current' : 'shelf' })) });
  assert.deepEqual(await readFile(join(root, 'binary.dat')), Buffer.from([0, 2])); await assert.rejects(readFile(join(root, 'other.txt')), { code: 'ENOENT' });
});

test('shelf handles unborn repositories and refuses stale state, symlinks, traversal, conflicts', async t => {
  const root = await fixture(t, false); await git(root, ['add', 'app.txt']); await writeFile(join(root, 'app.txt'), 'unstaged latest\n');
  const before = await snapshot(root), created = await shelve(root, ['app.txt']); assert.equal((await snapshot(root)).files.some(file => file.path === 'app.txt'), false);
  await restore(root, created.shelf.id); assert.equal((await snapshot(root)).revision, before.revision);
  await writeFile(join(root, 'app.txt'), 'external\n'); await assert.rejects(createShelf(root, before, { paths: ['app.txt'] }), /变化/);
  await symlink('app.txt', join(root, 'linked')); await assert.rejects(shelve(root, ['linked']), /读取|普通文件/);
  await assert.rejects(shelve(root, ['../outside']), /请选择/); await assert.rejects(restore(root, '../bad')); await assert.rejects(shelfDiff(root, created.shelf.id, '../outside'));
  await assert.rejects(shelve(root, ['app.txt'], { name: 'x'.repeat(121) }), /120/);
});

test('shelf sharing across worktrees and committed base updates remains recoverable', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'SHELF one\ntwo\nthree\nfour\nfive\n');
  const created = await shelve(root, ['app.txt']); await writeFile(join(root, 'app.txt'), 'one\ntwo\nthree\nfour\nCOMMIT five\n'); await git(root, ['add', 'app.txt']); await git(root, ['commit', '-m', 'upstream change']);
  const result = await restore(root, created.shelf.id); assert.equal(result.status, 'success');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'SHELF one\ntwo\nthree\nfour\nCOMMIT five\n');
  assert.equal(await git(root, ['show', ':app.txt']), 'one\ntwo\nthree\nfour\nCOMMIT five\n');
  const worktree = join(root, '../' + 'worktree-' + created.shelf.id); t.after(() => rm(worktree, { recursive: true, force: true }));
  await git(root, ['worktree', 'add', '-b', 'other-branch', worktree]); assert.equal((await listShelves(worktree))[0].id, created.shelf.id);
});

test('index lock failure rolls back work and preserves durable shelf backup', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'staged\n'); await git(root, ['add', 'app.txt']); await writeFile(join(root, 'app.txt'), 'working\n');
  const before = await snapshot(root), lock = join(root, '.git/index.lock'); await writeFile(lock, 'external git operation');
  await assert.rejects(shelve(root, ['app.txt']), /搁置未完成.*备份/s); await rm(lock);
  assert.equal((await snapshot(root)).revision, before.revision); const shelves = await listShelves(root); assert.equal(shelves.length, 1); assert.equal(shelves[0].phase, 'saved');
  const created = await shelve(root, ['app.txt']); const clean = await snapshot(root); await writeFile(lock, 'external git operation');
  await assert.rejects(restore(root, created.shelf.id), /恢复未完成/); await rm(lock);
  assert.equal((await snapshot(root)).revision, clean.revision); assert.equal((await listShelves(root)).length, 2);
});
