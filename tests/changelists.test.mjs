import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { git, snapshot } from '../server/git.mjs';
import { readChangelists, changelistAction } from '../server/changelists.mjs';
import { selectedCommit, collectSelected, generateSelectedMessage } from '../server/selected-commit.mjs';
import { updateRules } from '../server/exclusions.mjs';
const scratch = resolve(import.meta.dirname, '../../../work/git-panel-qa');
async function fixture(t, initial = true) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(scratch + '/groups-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Git Panel QA']); await git(root, ['config', 'user.email', 'qa@example.test']); await git(root, ['config', 'commit.gpgsign', 'false']);
  if (initial) { await writeFile(root + '/a.txt', 'original a\n'); await writeFile(root + '/b.txt', 'original b\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']); }
  return root;
}
test('selected commit uses working copy and preserves unrelated partially staged content', async t => {
  const root = await fixture(t);
  await writeFile(root + '/a.txt', 'staged a\n'); await writeFile(root + '/b.txt', 'staged b\n'); await git(root, ['add', '.']);
  await writeFile(root + '/a.txt', 'working a\n'); await writeFile(root + '/b.txt', 'working b\n');
  const before = await snapshot(root), result = await selectedCommit(root, before, { paths: ['a.txt'], message: 'selected a' });
  assert.equal(await git(root, ['show', 'HEAD:a.txt']), 'working a\n'); assert.equal(await git(root, ['show', 'HEAD:b.txt']), 'original b\n');
  assert.equal(await git(root, ['show', ':a.txt']), 'working a\n'); assert.equal(await git(root, ['show', ':b.txt']), 'staged b\n');
  assert.equal(await readFile(root + '/b.txt', 'utf8'), 'working b\n'); assert.equal(result.state.files.length, 1); assert.equal(result.state.files[0].code, 'MM');
});
test('selected untracked file commits without staging unrelated new files, including unborn repo', async t => {
  for (const initial of [true, false]) {
    const root = await fixture(t, initial), special = ':(glob)* [中文].txt';
    await writeFile(root + '/' + special, 'new selected\n'); await writeFile(root + '/other.txt', 'not selected\n'); await git(root, ['add', 'other.txt']);
    const before = await snapshot(root), index = await git(root, ['show', ':other.txt']);
    const data = await collectSelected(root, before, { paths: [special] }); assert.match(data.patch, /new selected/); assert.doesNotMatch(data.patch, /not selected/);
    await selectedCommit(root, before, { paths: [special], message: 'add literal filename' });
    assert.equal(await git(root, ['show', 'HEAD:' + special]), 'new selected\n'); assert.equal(await git(root, ['show', ':other.txt']), index);
    await assert.rejects(git(root, ['show', 'HEAD:other.txt']));
  }
});
test('selected rename and deletion are committed with both rename endpoints', async t => {
  const root = await fixture(t); await git(root, ['mv', 'a.txt', 'renamed.txt']); await rm(root + '/b.txt');
  const before = await snapshot(root); await selectedCommit(root, before, { paths: ['renamed.txt', 'b.txt'], message: 'rename and remove' });
  assert.equal(await git(root, ['ls-tree', '--name-only', 'HEAD']), 'renamed.txt\n'); assert.equal((await snapshot(root)).files.length, 0);
});
test('protected files and stale selections cannot be committed or analyzed', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'protected\n');
  await updateRules(root, await snapshot(root), { rules: [{ type: 'file', path: 'a.txt' }] });
  const before = await snapshot(root); await assert.rejects(selectedCommit(root, before, { paths: ['a.txt'], message: 'no' }), /永不提交/); await assert.rejects(collectSelected(root, before, { paths: ['a.txt'] }), /永不提交/);
  await writeFile(root + '/b.txt', 'first\n'); const stale = await snapshot(root); await writeFile(root + '/b.txt', 'other\n');
  await assert.rejects(selectedCommit(root, stale, { paths: ['b.txt'], message: 'no' }), /已变化/);
  assert.equal(await git(root, ['log', '-1', '--format=%s']), 'initial\n');
});
test('failed commit hooks retain exact real index and worktree', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'a staged\n'); await writeFile(root + '/b.txt', 'b staged\n'); await git(root, ['add', '.']); await writeFile(root + '/a.txt', 'a working\n');
  const hook = join(root, '.git/hooks/pre-commit'); await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
  const index = await readFile(root + '/.git/index'), before = await snapshot(root);
  await assert.rejects(selectedCommit(root, before, { paths: ['a.txt'], message: 'rejected by hook' }));
  assert.deepEqual(await readFile(root + '/.git/index'), index); assert.equal(await readFile(root + '/a.txt', 'utf8'), 'a working\n'); assert.equal((await snapshot(root)).revision, before.revision);
  await writeFile(hook, '#!/bin/sh\nexit 0\n'); await selectedCommit(root, before, { paths: ['a.txt'], message: 'retry works' });
});
test('real Git index lock blocks selection commit without interfering with another process', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'changed\n'); await writeFile(root + '/.git/index.lock', 'external lock');
  await assert.rejects(selectedCommit(root, await snapshot(root), { paths: ['a.txt'], message: 'no' }), /其他 Git 操作/);
  assert.equal(await readFile(root + '/.git/index.lock', 'utf8'), 'external lock');
});
test('AI selection is exact and never modifies index; stale AI response is rejected', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'chosen working copy\n'); await writeFile(root + '/b.txt', 'private unrelated\n'); await git(root, ['add', 'b.txt']);
  const before = await snapshot(root), index = await readFile(root + '/.git/index');
  const result = await generateSelectedMessage(root, before, { paths: ['a.txt'] }, async prompt => { assert.match(prompt, /chosen working copy/); assert.doesNotMatch(prompt, /private unrelated|b\.txt/); return { title: 'fix: 更新所选文件', body: '' }; });
  assert.equal(result.message, 'fix: 更新所选文件'); assert.deepEqual(result.paths, ['a.txt']); assert.deepEqual(await readFile(root + '/.git/index'), index);
  await assert.rejects(generateSelectedMessage(root, before, { paths: ['a.txt'] }, async () => { await writeFile(root + '/a.txt', 'changed while generating\n'); return { title: 'fix: 过期结果', body: '' }; }), /生成期间/);
});
test('changelist metadata persists, validates names, and keeps groups across Git branches', async t => {
  const root = await fixture(t); const initial = await readChangelists(root); assert.equal(initial.activeId, 'changes'); assert.equal(initial.newFilePolicy, 'manual');
  await writeFile(root + '/a.txt', 'changed a\n'); let before = await snapshot(root);
  let data = await changelistAction(root, before, { op: 'create', name: '我的功能' }); const id = data.groups.at(-1).id;
  await changelistAction(root, before, { op: 'move', groupId: id, paths: ['a.txt'] });
  await changelistAction(root, before, { op: 'rename', groupId: id, name: '功能 A' }); await git(root, ['switch', '-c', 'feature']);
  data = await readChangelists(root); assert.equal(data.assignments['a.txt'], id); assert.equal(data.groups.at(-1).name, '功能 A');
  await assert.rejects(changelistAction(root, before, { op: 'create', name: '永不提交' }), /系统分组/);
  await assert.rejects(changelistAction(root, before, { op: 'rename', groupId: 'changes', name: '覆盖默认' }), /不能重命名/);
  data = await changelistAction(root, before, { op: 'remove', groupId: id }); assert.equal(data.assignments['a.txt'], 'changes'); assert.equal(data.groups.length, 1); assert.equal(await readFile(root + '/a.txt', 'utf8'), 'changed a\n');
});
test('switching active group freezes existing changed files and rename preserves membership', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'changed a\n'); let before = await snapshot(root);
  let data = await changelistAction(root, before, { op: 'create', name: '后续更改' }); const id = data.groups.at(-1).id;
  data = await changelistAction(root, before, { op: 'set-active', groupId: id }); assert.equal(data.assignments['a.txt'], 'changes'); assert.equal(data.activeId, id);
  await writeFile(root + '/b.txt', 'newly changed\n'); before = await snapshot(root); data = await readChangelists(root, before.files); assert.equal(data.assignments['b.txt'] || data.activeId, id);
  await git(root, ['mv', 'a.txt', 'renamed.txt']); before = await snapshot(root); data = await readChangelists(root, before.files); assert.equal(data.assignments['renamed.txt'], 'changes'); assert.equal(Object.hasOwn(data.assignments, 'a.txt'), false);
  await changelistAction(root, before, { op: 'policy', newFilePolicy: 'auto' }); data = await readChangelists(root); assert.equal(data.newFilePolicy, 'auto'); assert.equal(data.assignments['renamed.txt'], 'changes');
});
test('group reads are side-effect free and protected membership cannot be bypassed', async t => {
  const root = await fixture(t); await readChangelists(root); await assert.rejects(readFile(root + '/.git/git-panel-changelists.json'), { code: 'ENOENT' });
  await writeFile(root + '/a.txt', 'private\n'); await updateRules(root, await snapshot(root), { rules: [{ type: 'file', path: 'a.txt' }] });
  await assert.rejects(changelistAction(root, await snapshot(root), { op: 'move', groupId: 'changes', paths: ['a.txt'] }), /永不提交/);
});
test('commit hooks cannot sweep unselected or protected files into a selection commit', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'selected\n'); await writeFile(root + '/b.txt', 'private\n');
  await updateRules(root, await snapshot(root), { rules: [{ type: 'file', path: 'b.txt' }] });
  const hooks = root + '/custom-hooks'; await mkdir(hooks); await git(root, ['config', 'core.hooksPath', 'custom-hooks']);
  const hook = hooks + '/commit-msg'; await writeFile(hook, '#!/bin/sh\ngit add b.txt\n'); await chmod(hook, 0o755);
  const before = await snapshot(root), index = await readFile(root + '/.git/index');
  await assert.rejects(selectedCommit(root, before, { paths: ['a.txt'], message: 'must stop' }), /未勾选的文件/);
  assert.deepEqual(await readFile(root + '/.git/index'), index); assert.equal(await git(root, ['log', '-1', '--format=%s']), 'initial\n');
});
test('selected-file formatter hooks still work and successful commit releases old group membership', async t => {
  const root = await fixture(t); await writeFile(root + '/a.txt', 'needs formatting\n'); await writeFile(root + '/b.txt', 'unrelated staged\n'); await git(root, ['add', 'b.txt']);
  let data = await changelistAction(root, await snapshot(root), { op: 'create', name: '整理' }); const id = data.groups.at(-1).id;
  await changelistAction(root, await snapshot(root), { op: 'move', groupId: id, paths: ['a.txt', 'b.txt'] });
  const hook = root + '/.git/hooks/pre-commit'; await writeFile(hook, '#!/bin/sh\nprintf "formatted\\n" > a.txt\ngit add a.txt\n'); await chmod(hook, 0o755);
  await selectedCommit(root, await snapshot(root), { paths: ['a.txt'], message: 'formatted' });
  assert.equal(await git(root, ['show', 'HEAD:a.txt']), 'formatted\n'); assert.equal(await git(root, ['show', ':b.txt']), 'unrelated staged\n');
  data = await readChangelists(root); assert.equal(Object.hasOwn(data.assignments, 'a.txt'), false); assert.equal(data.assignments['b.txt'], id);
});
