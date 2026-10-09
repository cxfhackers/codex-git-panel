import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, snapshot, mutate } from '../server/git.mjs';
import { readChangelists } from '../server/changelists.mjs';
import { autoAddPaths } from '../src/changes.js';

async function fixture(t, initial = true) {
  const scratch = resolve(import.meta.dirname, '../../../work/git-panel-qa');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(scratch + '/unversioned-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Git Panel QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']);
  if (initial) { await writeFile(root + '/tracked.txt', 'base\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']); }
  return root;
}
async function move(root, paths, state) {
  return mutate(root, 'changelist', { revision: (state || await snapshot(root)).revision, op: 'move', groupId: 'unversioned', paths });
}
test('undo add in normal and unborn repositories preserves latest disk contents and unrelated index entries', async t => {
  for (const initial of [true, false]) {
    const root = await fixture(t, initial);
    const path = '新文件 [1].txt';
    await writeFile(root + '/' + path, 'staged\n'); await writeFile(root + '/other.txt', 'other index\n');
    await git(root, ['add', path, 'other.txt']);
    await writeFile(root + '/' + path, 'latest working\n');
    const before = await snapshot(root), result = await move(root, [path]);
    assert.equal(result.state.head, before.head);
    assert.equal(result.state.files.find(f => f.path === path).code, '??');
    assert.equal(await readFile(root + '/' + path, 'utf8'), 'latest working\n');
    assert.equal(await git(root, ['show', ':other.txt']), 'other index\n');
    assert.equal((await git(root, ['ls-files', '--', path])).trim(), '');
  }
});
test('moving protected new files out preserves directory protection for all other files', async t => {
  const root = await fixture(t); await mkdir(root + '/local');
  await writeFile(root + '/local/one.txt', 'one'); await writeFile(root + '/local/two.txt', 'two');
  await git(root, ['add', 'local/one.txt']);
  let state = await snapshot(root);
  state = (await mutate(root, 'exclusions', { revision: state.revision, rules: [{ type: 'directory', path: 'local' }] })).state;
  assert.equal(state.files.find(f => f.path === 'local/one.txt').excluded, true);
  state = (await move(root, ['local/one.txt'], state)).state;
  assert.equal(state.files.find(f => f.path === 'local/one.txt').excluded, false);
  assert.equal(state.files.find(f => f.path === 'local/one.txt').code, '??');
  assert.equal(state.files.find(f => f.path === 'local/two.txt').excluded, true);
  assert.equal(await readFile(root + '/local/one.txt', 'utf8'), 'one');
});
test('committed files and mixed selections are rejected before any index or protection changes', async t => {
  const root = await fixture(t);
  await writeFile(root + '/tracked.txt', 'working\n'); await writeFile(root + '/new.txt', 'new\n'); await git(root, ['add', '.']);
  const index = await git(root, ['ls-files', '--stage', '-z']);
  await assert.rejects(move(root, ['new.txt', 'tracked.txt']), /已提交过/);
  assert.equal(await git(root, ['ls-files', '--stage', '-z']), index);
  assert.equal(await readFile(root + '/tracked.txt', 'utf8'), 'working\n');
});
test('manual undo-add persists across reloads, overrides auto-add, and is cleared by explicit add', async t => {
  const root = await fixture(t);
  await writeFile(root + '/new.txt', 'new\n'); await git(root, ['add', 'new.txt']);
  let state = await snapshot(root);
  await mutate(root, 'changelist', { revision: state.revision, op: 'policy', newFilePolicy: 'auto' });
  await move(root, ['new.txt']);
  assert.deepEqual((await readChangelists(root)).manualUntracked, ['new.txt']);
  await writeFile(root + '/another.txt', 'another\n');
  state = await snapshot(root); assert.deepEqual(autoAddPaths(state), ['another.txt']);
  state = (await mutate(root, 'set-staging', { revision: state.revision, staged: true, paths: ['new.txt'] })).state;
  assert.deepEqual(state.changelists.manualUntracked, []);
  assert.equal(state.files.find(f => f.path === 'new.txt').code, 'A ');
});
test('stale drag cannot undo a newer add or change', async t => {
  const root = await fixture(t); await writeFile(root + '/new.txt', 'new\n'); await git(root, ['add', 'new.txt']);
  const before = await snapshot(root); await writeFile(root + '/new.txt', 'changed\n');
  await assert.rejects(move(root, ['new.txt'], before), /已变化/);
  assert.equal(await git(root, ['show', ':new.txt']), 'new\n');
});
