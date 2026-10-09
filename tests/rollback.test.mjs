import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, snapshot, mutate } from '../server/git.mjs';
import { listShelves } from '../server/shelves.mjs';
import { autoAddPaths } from '../src/changes.js';

async function fixture(t, committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-panel-rollback-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']);
  if (committed) {
    await writeFile(join(root, 'chosen.txt'), 'base\n'); await writeFile(join(root, 'other.txt'), 'other base\n');
    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  }
  return root;
}
async function rollback(root, paths, extra = {}) {
  return mutate(root, 'rollback', { revision: (await snapshot(root)).revision, paths, confirm: true, ...extra });
}

test('rollback selected partial staging to HEAD preserves other work, index, history and restorable backup', async t => {
  const root = await fixture(t), head = (await snapshot(root)).head;
  await writeFile(join(root, 'chosen.txt'), 'index\n'); await writeFile(join(root, 'other.txt'), 'other index\n'); await git(root, ['add', '.']);
  await writeFile(join(root, 'chosen.txt'), 'working\n'); await writeFile(join(root, 'other.txt'), 'other working\n');
  const result = await rollback(root, ['chosen.txt']);
  assert.equal(await readFile(join(root, 'chosen.txt'), 'utf8'), 'base\n');
  assert.equal(await git(root, ['show', ':chosen.txt']), 'base\n');
  assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other working\n'); assert.equal(await git(root, ['show', ':other.txt']), 'other index\n');
  assert.equal(result.state.head, head); assert.deepEqual(result.state.files.map(f => f.path), ['other.txt']);
  assert.match((await listShelves(root))[0].name, /^回退备份/);
  await mutate(root, 'shelf-restore', { revision: result.state.revision, shelfId: result.shelf.id });
  assert.equal(await readFile(join(root, 'chosen.txt'), 'utf8'), 'working\n'); assert.equal(await git(root, ['show', ':chosen.txt']), 'index\n');
});

test('rollback protected modifications keeps protection and batch restores deleted, binary and literal filenames', async t => {
  const root = await fixture(t), special = '新 :[abc]*.bin', base = Buffer.from([0, 255, 20]);
  await writeFile(join(root, special), base); await chmod(join(root, special), 0o755); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'binary']);
  await writeFile(join(root, special), Buffer.from([0, 1])); await rm(join(root, 'other.txt')); await writeFile(join(root, 'chosen.txt'), 'protected\n');
  await mutate(root, 'exclusions', { revision: (await snapshot(root)).revision, rules: [{ type: 'file', path: 'chosen.txt' }] });
  const result = await rollback(root, [special, 'other.txt', 'chosen.txt']);
  assert.equal(result.state.files.length, 0); assert.equal(result.state.exclusions[0].path, 'chosen.txt');
  assert.deepEqual(await readFile(join(root, special)), base); assert.equal((await stat(join(root, special))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other base\n');
});

test('rollback staged rename restores source and removes destination, with recoverable rename', async t => {
  const root = await fixture(t); await git(root, ['mv', 'chosen.txt', 'renamed.txt']);
  await writeFile(join(root, 'renamed.txt'), 'renamed edit\n');
  const result = await rollback(root, ['renamed.txt']);
  assert.equal(result.state.files.length, 0); assert.equal(await readFile(join(root, 'chosen.txt'), 'utf8'), 'base\n');
  await assert.rejects(readFile(join(root, 'renamed.txt')), { code: 'ENOENT' });
  await mutate(root, 'shelf-restore', { revision: result.state.revision, shelfId: result.shelf.id });
  assert.equal(await readFile(join(root, 'renamed.txt'), 'utf8'), 'renamed edit\n');
});

test('rollback added files keeps newest content and suppresses auto-add in normal and unborn repos', async t => {
  for (const committed of [true, false]) {
    const root = await fixture(t, committed);
    await writeFile(join(root, 'new.txt'), 'index\n'); await git(root, ['add', 'new.txt']); await writeFile(join(root, 'new.txt'), 'latest\n');
    await mutate(root, 'changelist', { revision: (await snapshot(root)).revision, op: 'policy', newFilePolicy: 'auto' });
    const result = await rollback(root, ['new.txt']);
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'latest\n');
    assert.equal(result.state.files.find(f => f.path === 'new.txt').code, '??'); assert.deepEqual(autoAddPaths(result.state), []);
    assert.deepEqual(autoAddPaths(await snapshot(root)), []);
  }
});

test('rollback refuses unconfirmed, stale, untracked, and unsafe selections before writes', async t => {
  const root = await fixture(t); await writeFile(join(root, 'chosen.txt'), 'keep\n');
  const before = await snapshot(root);
  await assert.rejects(rollback(root, ['chosen.txt'], { confirm: false }), /确认/);
  await writeFile(join(root, 'new.txt'), 'keep new\n');
  await assert.rejects(rollback(root, ['chosen.txt'], { revision: before.revision }), /已变化/);
  await assert.rejects(rollback(root, ['chosen.txt', 'new.txt']), /未受版本控制/);
  await assert.rejects(rollback(root, ['../escape']), /请选择/);
  await rm(join(root, 'other.txt')); await symlink('chosen.txt', join(root, 'other.txt'));
  await assert.rejects(rollback(root, ['chosen.txt', 'other.txt']), /符号链接|普通文件|不支持|ELOOP/);
  assert.equal(await readFile(join(root, 'chosen.txt'), 'utf8'), 'keep\n');
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'keep new\n'); assert.equal((await listShelves(root)).length, 0);
});
