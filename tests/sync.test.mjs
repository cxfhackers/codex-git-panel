import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { git, snapshot, mutate } from '../server/git.mjs';
import { syncTargets } from '../server/sync.mjs';
const scratch = new URL('../../../work/git-panel-qa/', import.meta.url).pathname;
async function setup(t) {
  await mkdir(scratch, { recursive: true }); const base = await mkdtemp(join(scratch, 'sync-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'local'), remote = join(base, 'remote.git'), other = join(base, 'other');
  await mkdir(root); await mkdir(remote); await git(remote, ['init', '--bare', '-b', 'main']); await git(root, ['init', '-b', 'main']);
  await identity(root); await writeFile(join(root, 'a.txt'), 'original\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  await git(root, ['remote', 'add', 'origin', remote]); await git(root, ['push', '-u', 'origin', 'main']);
  await git(base, ['clone', remote, other]); await identity(other);
  return { base, root, remote, other };
}
async function identity(root) { await git(root, ['config', 'user.name', 'Sync QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']); await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']); }
async function commit(root, path, value, message) { await writeFile(join(root, path), value); await git(root, ['add', '--', path]); await git(root, ['commit', '-m', message]); return (await snapshot(root)).head; }
async function check(root, values = {}) { const state = await snapshot(root); return mutate(root, 'sync-check', { revision: state.revision, remote: 'origin', branch: 'main', strategy: 'merge', setUpstream: false, ...values }); }
async function execute(root, preview, action = 'push') { return mutate(root, action, { revision: preview.state.revision, previewToken: preview.previewToken }); }
async function tip(remote, branch = 'main') { return (await git(remote, ['rev-parse', 'refs/heads/' + branch])).trim(); }

test('commit without push is visible with an empty index; push preserves unrelated dirty files', async t => {
  const { root, remote } = await setup(t); const head = await commit(root, 'local.txt', 'local\n', 'local');
  const state = await snapshot(root); assert.equal(state.files.length, 0); assert.equal(state.sync.ahead, 1);
  await writeFile(join(root, 'a.txt'), 'uncommitted\n'); const preview = await check(root); assert.equal(preview.ahead, 1); assert.equal(preview.behind, 0);
  const result = await execute(root, preview); assert.equal(result.pushed, true); assert.equal(await tip(remote), head); assert.equal(result.state.sync.ahead, 0);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'uncommitted\n'); assert.equal(result.state.files.length, 1);
  await assert.rejects(execute(root, preview), /失效|变化/);
});
for (const strategy of ['merge', 'rebase']) test(`diverged histories update using ${strategy} and push both local and remote changes`, async t => {
  const { root, remote, other } = await setup(t);
  const localHead = await commit(root, 'local.txt', 'local\n', 'local'); const remoteHead = await commit(other, 'remote.txt', 'remote\n', 'remote'); await git(other, ['push', 'origin', 'main']);
  const preview = await check(root, { strategy }); assert.equal(preview.ahead, 1); assert.equal(preview.behind, 1);
  const result = await execute(root, preview); assert.equal(result.status, 'success'); assert.equal(result.pushed, true); assert.equal(await tip(remote), result.state.head);
  assert.equal(await git(root, ['show', 'HEAD:local.txt']), 'local\n'); assert.equal(await git(root, ['show', 'HEAD:remote.txt']), 'remote\n');
  await git(root, ['merge-base', '--is-ancestor', remoteHead, 'HEAD']);
  if (strategy === 'merge') { await git(root, ['merge-base', '--is-ancestor', localHead, 'HEAD']); assert.equal((await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length, 3); }
  else assert.equal((await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length, 2);
  assert.equal(result.state.files.length, 0);
});
test('update alone fast-forwards without pushing local commits', async t => {
  const { root, remote, other } = await setup(t); const remoteHead = await commit(other, 'remote.txt', 'remote\n', 'remote'); await git(other, ['push']);
  const result = await execute(root, await check(root), 'sync-update'); assert.equal(result.pushed, false); assert.equal(result.state.head, remoteHead); assert.equal(await tip(remote), remoteHead); assert.equal(result.state.sync.ahead, 0); assert.equal(result.state.sync.behind, 0);
});
test('rebase automatically saves untracked edits, updates and pushes, then restores local files', async t => {
  const { root, remote, other } = await setup(t); const localHead = await commit(root, 'local.txt', 'local\n', 'local');
  const remoteHead = await commit(other, 'remote.txt', 'remote\n', 'remote'); await git(other, ['push']); await writeFile(join(root, 'untracked.txt'), 'keep\n');
  const preview = await check(root, { strategy: 'rebase' }); const result = await execute(root, preview); assert.equal(result.pushed, true); assert.equal(await tip(remote), result.state.head); assert.equal(result.state.operation, null); assert.equal(await readFile(join(root, 'untracked.txt'), 'utf8'), 'keep\n'); await assert.rejects(git(remote, ['show', 'refs/heads/main:untracked.txt']));
});

test('Merge update and push retain unrelated local edits without publishing them', async t => {
  const { root, remote, other } = await setup(t);
  await commit(root, 'local.txt', 'local\n', 'local');
  await commit(other, 'remote.txt', 'remote\n', 'remote'); await git(other, ['push']);
  const committed = await git(root, ['show', 'HEAD:a.txt']);
  await writeFile(join(root, 'a.txt'), 'local config only\n'); await writeFile(join(root, 'notes.txt'), 'notes only\n');
  const result = await execute(root, await check(root));
  assert.equal(result.pushed, true); assert.equal(result.state.files.length, 2);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'local config only\n');
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'notes only\n');
  assert.equal(await git(remote, ['show', 'refs/heads/main:a.txt']), committed);
  await assert.rejects(git(remote, ['show', 'refs/heads/main:notes.txt']));
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
});

for (const abort of [false, true]) test(`rebase conflict ${abort ? 'abort' : 'continue'} restores saved staged and untracked files`, async t => {
  const { root, remote, other } = await setup(t);
  const head = await commit(root, 'a.txt', 'local branch\n', 'local');
  await commit(other, 'a.txt', 'remote branch\n', 'remote'); await git(other, ['push']);
  const remoteHead = await tip(remote);
  await writeFile(join(root, 'config.txt'), 'staged local config\n'); await git(root, ['add', 'config.txt']);
  await writeFile(join(root, 'notes.txt'), 'private notes\n');
  let result = await execute(root, await check(root, { strategy: 'rebase' }));
  assert.equal(result.status, 'conflict'); assert.equal(result.pushed, false);
  assert.ok(result.state.operation.localBackup.oid);
  assert.equal(result.state.files.some(f => f.path === 'config.txt' || f.path === 'notes.txt'), false);
  if (!abort) {
    await writeFile(join(root, 'a.txt'), 'resolved branches\n');
    await mutate(root, 'resolve', { revision: (await snapshot(root)).revision, path: 'a.txt' });
  }
  result = await mutate(root, abort ? 'rebase-abort' : 'rebase-continue', { revision: (await snapshot(root)).revision });
  assert.equal(result.state.operation, null); assert.equal(result.status, 'success');
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'private notes\n');
  assert.equal(await git(root, ['show', ':config.txt']), 'staged local config\n');
  await assert.rejects(git(root, ['show', 'HEAD:config.txt']));
  assert.equal(await tip(remote), remoteHead);
  if (abort) assert.equal(result.state.head, head);
});

test('restoring overlapping local edits after rebase pauses push and keeps the exact backup', async t => {
  const { root, remote, other } = await setup(t);
  await commit(root, 'local.txt', 'local\n', 'local');
  await commit(other, 'a.txt', 'remote config\n', 'remote'); await git(other, ['push']);
  const remoteHead = await tip(remote);
  await writeFile(join(root, 'a.txt'), 'local config, never commit\n');
  const result = await execute(root, await check(root, { strategy: 'rebase' }));
  assert.equal(result.status, 'restore-conflict'); assert.equal(result.pushed, false);
  assert.equal(result.state.operation.type, 'local-restore');
  const oid = result.state.operation.localBackup.oid;
  assert.equal(await git(root, ['show', oid + ':a.txt']), 'local config, never commit\n');
  assert.equal(await git(root, ['show', 'HEAD:a.txt']), 'remote config\n');
  assert.equal(await tip(remote), remoteHead);
  await assert.rejects(mutate(root, 'restore-finish', { revision: result.state.revision }), /解决恢复冲突/);
  await writeFile(join(root, 'a.txt'), 'resolved local config\n');
  await mutate(root, 'resolve', { revision: (await snapshot(root)).revision, path: 'a.txt' });
  const finished = await mutate(root, 'restore-finish', { revision: (await snapshot(root)).revision });
  assert.equal(finished.state.operation, null); assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
  const pushed = await execute(root, await check(root)); assert.equal(pushed.pushed, true);
  assert.equal(await git(remote, ['show', 'refs/heads/main:a.txt']), 'remote config\n');
});
test('a remote advance after approval returns a fresh preview and does not push', async t => {
  const { root, remote, other } = await setup(t); const head = await commit(root, 'local.txt', 'local\n', 'local'); const preview = await check(root);
  const remoteHead = await commit(other, 'remote.txt', 'remote\n', 'remote'); await git(other, ['push']);
  const result = await execute(root, preview); assert.equal(result.status, 'remote-changed'); assert.equal(result.behind, 1); assert.notEqual(result.previewToken, preview.previewToken);
  assert.equal((await snapshot(root)).head, head); assert.equal(await tip(remote), remoteHead);
});
test('a local edit after preview rejects the action', async t => {
  const { root, remote } = await setup(t); const previousRemote = await tip(remote); await commit(root, 'local.txt', 'local\n', 'local'); const preview = await check(root);
  await writeFile(join(root, 'a.txt'), 'changed\n'); await assert.rejects(execute(root, preview), /变化/); assert.equal(await tip(remote), previousRemote);
});
for (const strategy of ['merge', 'rebase']) test(`${strategy} conflict stops before push, can resolve and continue, then recheck and push`, async t => {
  const { root, remote, other } = await setup(t); await commit(root, 'a.txt', 'local\n', 'local'); const remoteHead = await commit(other, 'a.txt', 'remote\n', 'remote'); await git(other, ['push']);
  let result = await execute(root, await check(root, { strategy })); assert.equal(result.status, 'conflict'); assert.equal(result.pushed, false); assert.equal(result.state.operation.type, strategy); assert.equal(await tip(remote), remoteHead);
  await writeFile(join(root, 'a.txt'), 'resolved\n'); let state = await snapshot(root); state = (await mutate(root, 'resolve', { revision: state.revision, path: 'a.txt' })).state;
  result = await mutate(root, strategy + '-continue', { revision: state.revision }); assert.equal(result.state.operation, null);
  result = await execute(root, await check(root)); assert.equal(result.pushed, true); assert.equal(await tip(remote), result.state.head);
});
test('first publication explicitly creates only the chosen remote branch and configures upstream', async t => {
  const { root, remote } = await setup(t); const original = await tip(remote); await git(root, ['branch', '--unset-upstream']);
  assert.equal((await syncTargets(root)).setUpstream, true);
  const head = await commit(root, 'local.txt', 'local\n', 'local'); const preview = await check(root, { branch: 'feature/new', setUpstream: true }); assert.equal(preview.remoteExists, false);
  const result = await execute(root, preview); assert.equal(result.pushed, true); assert.equal(result.state.upstream, 'origin/feature/new'); assert.equal(await tip(remote, 'feature/new'), head); assert.equal(await tip(remote), original);
});
test('explicit one-branch push overrides mirror, matching, configured force refspec and automatic tags', async t => {
  const { root, remote } = await setup(t); await git(root, ['branch', 'extra']); await git(root, ['tag', '-a', 'qa-tag', '-m', 'qa']);
  await git(root, ['config', 'push.default', 'matching']); await git(root, ['config', 'push.followTags', 'true']); await git(root, ['config', 'remote.origin.mirror', 'true']); await git(root, ['config', 'remote.origin.push', '+refs/heads/*:refs/heads/*']);
  await commit(root, 'local.txt', 'local\n', 'local'); const result = await execute(root, await check(root)); assert.equal(result.pushed, true);
  assert.equal((await git(remote, ['for-each-ref', '--format=%(refname)'])).trim(), 'refs/heads/main');
});
test('multiple push endpoints are rejected; differing fetch and push endpoints use the push destination', async t => {
  const { root, remote, base } = await setup(t); const second = join(base, 'second.git'); await mkdir(second); await git(second, ['init', '--bare', '-b', 'main']);
  await git(root, ['config', '--add', 'remote.origin.pushurl', second]); const preview = await check(root); assert.equal(preview.remoteExists, false);
  const result = await execute(root, preview); assert.equal(result.pushed, true); assert.equal(await tip(second), result.state.head);
  assert.equal((await snapshot(root)).sync.ahead, 0); // Conventional fetch tracking is not overwritten with the other endpoint.
  await git(root, ['config', '--add', 'remote.origin.pushurl', remote]); await assert.rejects(check(root), /多个推送地址/);
});
test('push rejection reports that local integration succeeded and keeps local commits', async t => {
  const { root, remote, other } = await setup(t); await commit(root, 'local.txt', 'local\n', 'local'); const remoteHead = await commit(other, 'remote.txt', 'remote\n', 'remote'); await git(other, ['push']);
  const hook = join(remote, 'hooks/pre-receive'); await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
  const result = await execute(root, await check(root)); assert.equal(result.status, 'push-failed'); assert.match(result.warning, /本地更新已完成/); assert.equal(await tip(remote), remoteHead);
  assert.equal(await git(root, ['show', 'HEAD:local.txt']), 'local\n'); assert.equal(await git(root, ['show', 'HEAD:remote.txt']), 'remote\n');
});
test('rebase can be aborted and restores the original local commit', async t => {
  const { root, remote, other } = await setup(t); const localHead = await commit(root, 'a.txt', 'local\n', 'local'); const remoteHead = await commit(other, 'a.txt', 'remote\n', 'remote'); await git(other, ['push']);
  const result = await execute(root, await check(root, { strategy: 'rebase' })); assert.equal(result.state.operation.type, 'rebase');
  const aborted = await mutate(root, 'rebase-abort', { revision: result.state.revision }); assert.equal(aborted.state.head, localHead); assert.equal(aborted.state.operation, null); assert.equal(await tip(remote), remoteHead);
});
test('remote race during pre-push rejects normally and never overwrites remote history', async t => {
  const { root, remote, other } = await setup(t); const localHead = await commit(root, 'local.txt', 'local\n', 'local');
  const hooks = join(root, '.git/hooks'); await git(root, ['config', 'core.hooksPath', hooks]);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const hook = join(hooks, 'pre-push'); await writeFile(hook, '#!/bin/sh\n' + `git -C ${quote(other)} commit --allow-empty -m race >/dev/null\ngit -C ${quote(other)} push origin main >/dev/null 2>&1\n`); await chmod(hook, 0o755);
  const result = await execute(root, await check(root)); assert.equal(result.status, 'push-failed'); assert.equal(result.state.head, localHead); assert.notEqual(await tip(remote), localHead);
  assert.equal((await git(remote, ['log', '-1', '--format=%s'])).trim(), 'race');
});
