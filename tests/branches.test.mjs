import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, snapshot, mutate } from '../server/git.mjs';
import { branchList, mergePreview } from '../server/branches.mjs';
const scratch = resolve(import.meta.dirname, '../../../work/git-panel-qa');
async function fixture(t) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(scratch + '/branches-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Git Branch QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(root + '/a.txt', 'initial\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  return root;
}
async function args(root, name) {
  const data = await branchList(root), target = data.branches.find(b => b.name === name);
  assert.ok(target, `missing ${name}`);
  return { revision: data.state.revision, ref: target.ref, targetOid: target.oid };
}
async function topic(root, conflict = false) {
  await git(root, ['switch', '-c', 'feature']);
  await writeFile(root + (conflict ? '/a.txt' : '/feature.txt'), 'feature\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'feature change']);
  await git(root, ['switch', 'main']);
}
test('switches same-commit branches, changes revision, and preserves compatible dirty content', async t => {
  const root = await fixture(t); await git(root, ['branch', 'other']);
  await writeFile(root + '/a.txt', 'uncommitted\n'); const before = await snapshot(root);
  const result = await mutate(root, 'switch', await args(root, 'other'));
  assert.equal(result.state.branch, 'other'); assert.equal(result.state.head, before.head);
  assert.notEqual(result.state.revision, before.revision);
  assert.equal(await readFile(root + '/a.txt', 'utf8'), 'uncommitted\n');
  await assert.rejects(mutate(root, 'stage', { revision: before.revision, path: 'a.txt' }), /已变化/);
});
test('refuses an overlapping dirty switch without changing the branch or overwriting files', async t => {
  const root = await fixture(t); await topic(root, true); await writeFile(root + '/a.txt', 'keep local edit\n');
  await assert.rejects(mutate(root, 'switch', await args(root, 'feature')), /overwritten|local changes/);
  assert.equal((await snapshot(root)).branch, 'main');
  assert.equal(await readFile(root + '/a.txt', 'utf8'), 'keep local edit\n');
});
test('lists remote refs without HEAD aliases and creates a local tracking branch', async t => {
  const root = await fixture(t); await git(root, ['branch', 'remote-topic']);
  await git(root, ['remote', 'add', 'origin', root]); await git(root, ['fetch', 'origin']);
  await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  await git(root, ['branch', '-d', 'remote-topic']);
  const list = await branchList(root);
  assert.ok(list.branches.some(b => b.name === 'origin/remote-topic' && b.type === 'remote'));
  assert.ok(!list.branches.some(b => b.name === 'origin/HEAD'));
  const result = await mutate(root, 'switch', await args(root, 'origin/remote-topic'));
  assert.equal(result.state.branch, 'remote-topic'); assert.equal(result.state.upstream, 'origin/remote-topic');
  await assert.rejects(mutate(root, 'switch', await args(root, 'origin/main')), /同名本地/);
});
test('previews and fast-forwards into the current branch, keeping the source branch unchanged', async t => {
  const root = await fixture(t); await topic(root); const input = await args(root, 'feature');
  const preview = await mergePreview(root, input);
  assert.equal(preview.incoming, 1); assert.equal(preview.currentOnly, 0);
  assert.equal(preview.commits[0].subject, 'feature change');
  const result = await mutate(root, 'merge', input);
  assert.equal(result.state.branch, 'main'); assert.equal(result.state.head, input.targetOid);
  assert.equal(result.state.operation, null); assert.deepEqual(result.state.files, []);
  assert.equal((await git(root, ['rev-parse', 'feature'])).trim(), input.targetOid);
});
test('creates a true merge commit for divergent clean branches', async t => {
  const root = await fixture(t); await topic(root);
  await writeFile(root + '/main.txt', 'main\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'main change']);
  const input = await args(root, 'feature'), head = (await snapshot(root)).head;
  const preview = await mergePreview(root, input); assert.equal(preview.currentOnly, 1); assert.equal(preview.incoming, 1);
  const result = await mutate(root, 'merge', input);
  assert.equal(result.state.branch, 'main'); assert.equal(result.state.operation, null);
  assert.equal((await git(root, ['show', '-s', '--format=%P', 'HEAD'])).trim(), `${head} ${input.targetOid}`);
  assert.equal(await readFile(root + '/feature.txt', 'utf8'), 'feature\n');
});
test('rejects stale source tips and arbitrary refs; no-op merge preserves dirty content', async t => {
  const root = await fixture(t); await topic(root); const input = await args(root, 'feature');
  await git(root, ['update-ref', 'refs/heads/feature', (await snapshot(root)).head]);
  await assert.rejects(mutate(root, 'merge', input), /目标分支已变化/);
  await assert.rejects(mutate(root, 'switch', { ...input, ref: 'HEAD~1' }), /分支不存在/);
  await writeFile(root + '/new.txt', 'do not overwrite\n');
  const result = await mutate(root, 'merge', await args(root, 'feature')); assert.equal(result.status, 'success');
  assert.equal(await readFile(root + '/new.txt', 'utf8'), 'do not overwrite\n');
});
test('returns conflict state, blocks continuation until resolved, and completes a merge', async t => {
  const root = await fixture(t); await topic(root, true);
  await writeFile(root + '/a.txt', 'main\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'main change']);
  const input = await args(root, 'feature'), original = await snapshot(root);
  let result = await mutate(root, 'merge', input);
  assert.equal(result.status, 'conflict'); assert.equal(result.state.operation.type, 'merge');
  assert.equal(result.state.head, original.head); assert.ok(result.state.files[0].conflict);
  assert.equal(result.state.files[0].staged, false); assert.equal(result.state.files[0].unstaged, true);
  await assert.rejects(mutate(root, 'merge-continue', { revision: result.state.revision }), /解决冲突/);
  await assert.rejects(mutate(root, 'resolve', { revision: result.state.revision, path: 'a.txt' }), /仍有冲突标记/);
  await assert.rejects(mutate(root, 'switch', await args(root, 'feature')), /当前 Git 操作/);
  await writeFile(root + '/a.txt', 'resolved\n');
  await mutate(root, 'resolve', { revision: (await snapshot(root)).revision, path: 'a.txt' });
  result = await mutate(root, 'merge-continue', { revision: (await snapshot(root)).revision });
  assert.equal(result.state.operation, null); assert.deepEqual(result.state.files, []);
  assert.equal((await git(root, ['show', '-s', '--format=%P', 'HEAD'])).trim(), `${original.head} ${input.targetOid}`);
});
test('aborts a conflicted merge after confirmation and preserves newly created untracked files', async t => {
  const root = await fixture(t); await topic(root, true);
  await writeFile(root + '/a.txt', 'main\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'main change']);
  const before = await snapshot(root); let result = await mutate(root, 'merge', await args(root, 'feature'));
  await writeFile(root + '/notes.txt', 'keep notes\n');
  await assert.rejects(mutate(root, 'merge-abort', { revision: result.state.revision }), /已变化/);
  result = await mutate(root, 'merge-abort', { revision: (await snapshot(root)).revision });
  assert.equal(result.state.head, before.head); assert.equal(result.state.operation, null);
  assert.equal(await readFile(root + '/a.txt', 'utf8'), 'main\n');
  assert.equal(await readFile(root + '/notes.txt', 'utf8'), 'keep notes\n');
});

for (const divergent of [false, true]) test(`merges ${divergent ? 'divergent' : 'fast-forward'} history while leaving two unwanted files uncommitted`, async t => {
  const root = await fixture(t); await topic(root);
  if (divergent) {
    await writeFile(root + '/main.txt', 'main\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'main']);
  }
  await writeFile(root + '/a.txt', 'local configuration only\n');
  await writeFile(root + '/private-notes.txt', 'keep untracked\n');
  const input = await args(root, 'feature');
  assert.equal((await mergePreview(root, input)).state.files.length, 2);
  const result = await mutate(root, 'merge', input);
  assert.equal(result.status, 'success'); assert.equal(result.state.files.length, 2);
  assert.equal(await readFile(root + '/a.txt', 'utf8'), 'local configuration only\n');
  assert.equal(await readFile(root + '/private-notes.txt', 'utf8'), 'keep untracked\n');
  assert.equal(await git(root, ['show', 'HEAD:a.txt']), 'initial\n');
  await assert.rejects(git(root, ['show', 'HEAD:private-notes.txt']));
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
  assert.match(await git(root, ['stash', 'list']), /git-panel-auto-/);
});

for (const untracked of [false, true]) test(`saves overlapping ${untracked ? 'untracked' : 'tracked'} content and retains a recoverable backup on restore conflict`, async t => {
  const root = await fixture(t); await topic(root, !untracked);
  const file = untracked ? 'feature.txt' : 'a.txt';
  await writeFile(root + '/' + file, 'do not submit or overwrite\n');
  const input = await args(root, 'feature');
  const result = await mutate(root, 'merge', input);
  assert.equal(result.status, 'restore-conflict'); assert.equal(result.state.head, input.targetOid);
  assert.equal(result.state.operation.type, 'local-restore');
  const oid = result.state.operation.localBackup.oid;
  assert.equal(await git(root, ['show', `${oid}${untracked ? '^3' : ''}:${file}`]), 'do not submit or overwrite\n');
  assert.equal(await git(root, ['show', 'HEAD:' + file]), 'feature\n');
  await assert.rejects(mutate(root, 'restore-retry', { revision: result.state.revision }), /恢复已经开始/);
  await writeFile(root + '/' + file, 'keep chosen local version\n');
  if (!untracked) await mutate(root, 'resolve', { revision: (await snapshot(root)).revision, path: file });
  const finished = await mutate(root, 'restore-finish', { revision: (await snapshot(root)).revision });
  assert.equal(finished.state.operation, null); assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
  assert.equal(await readFile(root + '/' + file, 'utf8'), 'keep chosen local version\n');
});

test('automatically saves staged changes so they never enter the merge commit, then restores the index', async t => {
  const root = await fixture(t); await topic(root);
  await writeFile(root + '/main.txt', 'main\n'); await git(root, ['add', 'main.txt']); await git(root, ['commit', '-m', 'main']);
  await writeFile(root + '/a.txt', 'staged configuration\n'); await git(root, ['add', 'a.txt']);
  const result = await mutate(root, 'merge', await args(root, 'feature'));
  assert.equal(result.status, 'success'); assert.equal(result.state.operation, null);
  assert.equal(await git(root, ['show', ':a.txt']), 'staged configuration\n');
  assert.equal(await git(root, ['show', 'HEAD:a.txt']), 'initial\n');
  assert.equal(await readFile(root + '/a.txt', 'utf8'), 'staged configuration\n');
});

for (const abort of [false, true]) test(`can ${abort ? 'abort' : 'continue'} a conflicting merge while preserving pre-existing unrelated edits`, async t => {
  const root = await fixture(t);
  await writeFile(root + '/config.txt', 'committed config\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'config']);
  await topic(root, true);
  await writeFile(root + '/a.txt', 'main\n'); await git(root, ['add', 'a.txt']); await git(root, ['commit', '-m', 'main']);
  const original = await snapshot(root);
  await writeFile(root + '/config.txt', 'local config only\n');
  await writeFile(root + '/notes.txt', 'local notes\n');
  let result = await mutate(root, 'merge', await args(root, 'feature'));
  assert.equal(result.status, 'conflict');
  if (!abort) {
    await writeFile(root + '/a.txt', 'resolved\n');
    await mutate(root, 'resolve', { revision: (await snapshot(root)).revision, path: 'a.txt' });
  }
  result = await mutate(root, abort ? 'merge-abort' : 'merge-continue', { revision: (await snapshot(root)).revision });
  assert.equal(result.state.operation, null); assert.equal(result.state.files.length, 2);
  if (abort) assert.equal(result.state.head, original.head);
  else assert.equal(await git(root, ['show', 'HEAD:a.txt']), 'resolved\n');
  assert.equal(await readFile(root + '/config.txt', 'utf8'), 'local config only\n');
  assert.equal(await readFile(root + '/notes.txt', 'utf8'), 'local notes\n');
  assert.equal(await git(root, ['show', 'HEAD:config.txt']), 'committed config\n');
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
});
