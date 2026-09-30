import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, snapshot, mutate } from '../server/git.mjs';
import { listShelves } from '../server/shelves.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-panel-shelf-integration-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'QA']); await git(root, ['config', 'user.email', 'qa@example.test']); await git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'app.txt'), 'base\n'); await writeFile(join(root, 'other.txt'), 'other\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  return root;
}
async function act(root, action, body = {}) { return mutate(root, action, { revision: (await snapshot(root)).revision, ...body }); }
async function shelf(root, paths) { return act(root, 'shelf-create', { paths, name: 'integration shelf', groupId: 'changes' }); }

test('mutate restores protected shelf without removing protection or reporting a failed action', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'private settings\n');
  await act(root, 'exclusions', { rules: [{ type: 'file', path: 'app.txt' }] });
  const created = await shelf(root, ['app.txt']); assert.equal(created.state.files.length, 0);
  const restored = await act(root, 'shelf-restore', { shelfId: created.shelf.id, groupId: 'changes' });
  assert.equal(restored.status, 'success'); assert.equal(restored.state.files[0].excluded, true); assert.equal(restored.state.files[0].staged, false);
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'private settings\n'); assert.equal((await listShelves(root))[0].restoredPaths[0], 'app.txt');
});

test('mutate restore succeeds when shelved content is already committed and no changed file remains', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'shelved change\n'); const created = await shelf(root, ['app.txt']);
  await writeFile(join(root, 'app.txt'), 'shelved change\n'); await git(root, ['add', 'app.txt']); await git(root, ['commit', '-m', 'already integrated']);
  const before = await snapshot(root), restored = await act(root, 'shelf-restore', { shelfId: created.shelf.id, groupId: 'changes' });
  assert.equal(restored.status, 'success'); assert.equal(restored.state.files.length, 0); assert.equal(restored.state.head, before.head);
});

test('mutate conflict keep-current accepts a clean committed current version', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'shelved version\n'); const created = await shelf(root, ['app.txt']);
  await writeFile(join(root, 'app.txt'), 'current committed version\n'); await git(root, ['add', 'app.txt']); await git(root, ['commit', '-m', 'different current version']);
  const before = await snapshot(root), preview = await act(root, 'shelf-restore', { shelfId: created.shelf.id, groupId: 'changes' });
  assert.equal(preview.status, 'conflict'); assert.equal(preview.state.revision, before.revision);
  const restored = await act(root, 'shelf-restore', { shelfId: created.shelf.id, groupId: 'changes', resolutions: preview.conflicts.map(file => ({ path: file.path, token: file.token, choice: 'current' })) });
  assert.equal(restored.status, 'success'); assert.equal(restored.state.files.length, 0); assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'current committed version\n');
});

test('mutate restore maps rename source deletion to chosen group when destination is already unchanged', async t => {
  const root = await fixture(t); await git(root, ['mv', 'app.txt', 'renamed.txt']); const created = await shelf(root, ['renamed.txt']);
  await writeFile(join(root, 'renamed.txt'), 'base\n'); await git(root, ['add', 'renamed.txt']); await git(root, ['commit', '-m', 'destination already exists']);
  const grouped = await act(root, 'changelist', { op: 'create', name: 'restored feature' }), groupId = grouped.state.changelists.groups.find(group => group.name === 'restored feature').id;
  const restored = await act(root, 'shelf-restore', { shelfId: created.shelf.id, groupId });
  assert.equal(restored.status, 'success'); assert.deepEqual(restored.state.files.map(file => file.path), ['app.txt']);
  assert.equal(restored.state.changelists.assignments['app.txt'], groupId); assert.equal(await readFile(join(root, 'renamed.txt'), 'utf8'), 'base\n');
  assert.deepEqual(new Set(restored.affectedPaths), new Set(['app.txt', 'renamed.txt']));
});

test('invalid restoration group is rejected before changing any worktree or index content', async t => {
  const root = await fixture(t); await writeFile(join(root, 'app.txt'), 'shelved\n'); const created = await shelf(root, ['app.txt']), before = await snapshot(root);
  await assert.rejects(act(root, 'shelf-restore', { shelfId: created.shelf.id, groupId: 'removed-group' }), /分组/);
  assert.equal((await snapshot(root)).revision, before.revision); assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'base\n');
});
