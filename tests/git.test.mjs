import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, stat, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateMessage } from '../server/ai.mjs';
import { git, snapshot, mutate, diff, repository, splitHunks } from '../server/git.mjs';
const scratch = resolve(import.meta.dirname, '../../../work/git-panel-qa');
async function fixture(t, initial = true) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(scratch + '/test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Git Panel QA']); await git(root, ['config', 'user.email', 'qa@example.test']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  if (initial) { await writeFile(root + '/a.txt', 'original\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']); }
  return root;
}
test('commits only the index and preserves unrelated worktree changes', async t => {
  const root = await fixture(t);
  await writeFile(root + '/a.txt', 'edited\n'); await writeFile(root + '/new.ts', 'export const value = 1;\n');
  let state = await snapshot(root);
  state = (await mutate(root, 'stage', { path: 'new.ts', revision: state.revision })).state;
  const result = await mutate(root, 'commit', { message: 'add new file', revision: state.revision });
  assert.equal(await git(root, ['show', 'HEAD:a.txt']), 'original\n');
  assert.equal(await git(root, ['show', 'HEAD:new.ts']), 'export const value = 1;\n');
  assert.ok(result.state.files.some(f => f.path === 'a.txt' && f.unstaged));
});
test('rejects stale previews and rejects paths absent from status', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'first\n');
  const state = await snapshot(root); await writeFile(root + '/a.txt', 'second\n');
  await assert.rejects(mutate(root, 'stage', { path: 'a.txt', revision: state.revision }), /已变化/);
  const current = await snapshot(root);
  await assert.rejects(mutate(root, 'stage', { path: '../outside', revision: current.revision }), /更改列表/);
});
test('AI adapter analyzes only staged differences and returns editable message', async t => {
  const root = await fixture(t); await writeFile(root + '/README.md', '# Readme\n'); await writeFile(root + '/unstaged.js', 'not included\n');
  let state = await snapshot(root); state = (await mutate(root, 'stage', { path: 'README.md', revision: state.revision })).state;
  const result = await generateMessage(root, state, async prompt => { assert.match(prompt, /README.md/); assert.match(prompt, /Readme/); assert.doesNotMatch(prompt, /unstaged.js/); return { title: 'docs: 添加项目说明', body: '补充 README 文档。' }; });
  assert.match(result.message, /^docs: 添加项目说明/); assert.equal(result.source, 'ai');
  assert.ok(!result.message.includes('unstaged.js')); assert.equal(result.state.revision, state.revision);
});
test('stages and unstages one hunk while preserving the other hunk', async t => {
  const root = await fixture(t); const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(root + '/a.txt', original); await git(root, ['add', 'a.txt']); await git(root, ['commit', '-m', 'baseline']);
  const modified = original.replace('line 2\n', 'changed 2\n').replace('line 28\n', 'changed 28\n'); await writeFile(root + '/a.txt', modified);
  let state = await snapshot(root); assert.equal(splitHunks(await diff(root, 'a.txt', false)).hunks.length, 2);
  state = (await mutate(root, 'hunk', { path: 'a.txt', hunk: 0, staged: false, revision: state.revision })).state;
  const indexed = await git(root, ['show', ':a.txt']); assert.match(indexed, /changed 2/); assert.ok(!indexed.includes('changed 28'));
  assert.ok(state.files[0].staged && state.files[0].unstaged);
  state = (await mutate(root, 'hunk', { path: 'a.txt', hunk: 0, staged: true, revision: state.revision })).state;
  assert.equal(await git(root, ['show', ':a.txt']), original); assert.equal(await readFile(root + '/a.txt', 'utf8'), modified);
});
test('literal pathspecs protect special filenames and untracked preview', async t => {
  const root = await fixture(t); const path = ':(glob)* [中文] file.txt'; await writeFile(root + '/' + path, 'new content\n');
  let state = await snapshot(root); const patch = await diff(root, path, false); assert.match(patch, /new content/);
  state = (await mutate(root, 'stage', { path, revision: state.revision })).state;
  assert.equal(state.files.find(f => f.path === path)?.code, 'A '); assert.ok(!state.files.find(f => f.path === 'a.txt'));
});
test('unstages a rename without reverting worktree files', async t => {
  const root = await fixture(t); await git(root, ['mv', 'a.txt', 'renamed.txt']);
  let state = await snapshot(root); assert.equal(state.files[0].oldPath, 'a.txt');
  state = (await mutate(root, 'unstage', { path: 'renamed.txt', revision: state.revision })).state;
  assert.ok(state.files.some(f => f.path === 'a.txt' && f.code === ' D'));
  assert.equal(await readFile(root + '/renamed.txt', 'utf8'), 'original\n');
});
test('unstages a file in an unborn repository without deleting it', async t => {
  const root = await fixture(t, false); await writeFile(root + '/first.txt', 'hello\n');
  let state = await snapshot(root); state = (await mutate(root, 'stage', { path: 'first.txt', revision: state.revision })).state;
  state = (await mutate(root, 'unstage', { path: 'first.txt', revision: state.revision })).state;
  assert.equal(state.files[0].code, '??'); assert.equal(await readFile(root + '/first.txt', 'utf8'), 'hello\n');
});
test('opens repository from a subfolder and blocks empty commits', async t => {
  const root = await fixture(t); await mkdir(root + '/nested'); assert.equal(await repository(root + '/nested'), root);
  const state = await snapshot(root); await assert.rejects(mutate(root, 'commit', { message: '', revision: state.revision }), /填写/);
  await assert.rejects(mutate(root, 'commit', { message: 'nothing', revision: state.revision }), /没有已暂存/);
});
test('untracked revision ignores metadata-only updates but catches equal-length content edits', async t => {
  const root = await fixture(t); const path = root + '/new.txt'; await writeFile(path, 'first\n');
  const before = await snapshot(root), times = await stat(path);
  await utimes(path, times.atime, new Date(times.mtimeMs + 1000));
  assert.equal((await snapshot(root)).revision, before.revision);
  await writeFile(path, 'other\n'); await utimes(path, times.atime, times.mtime);
  assert.notEqual((await snapshot(root)).revision, before.revision);
  await assert.rejects(mutate(root, 'stage', { path: 'new.txt', revision: before.revision }), /已变化/);
});
