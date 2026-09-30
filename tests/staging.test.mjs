import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { git, snapshot, mutate } from '../server/git.mjs';
import { createStagingQueue, previewStaging } from '../src/staging.js';
const scratch = new URL('../../../work/git-panel-qa/', import.meta.url).pathname;
async function fixture(t, initial = true) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(join(scratch, 'staging-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Staging QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']); await git(root, ['config', 'commit.gpgsign', 'false']);
  if (initial) { await writeFile(join(root, 'config.txt'), 'base\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']); }
  for (const name of ['one.txt', 'two [中文].txt', 'three.txt']) await writeFile(join(root, name), name + '\n');
  return root;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness(root, state, send) {
  let context = { id: root, state }, pending = [], error = ''; const idle = deferred();
  const queue = createStagingQueue({ getContext: () => context, send,
    read: () => snapshot(root), onState: next => { context = { ...context, state: next }; },
    onPending: next => { pending = next; if (!next.length) idle.resolve(); }, onError: next => { error = next; },
  });
  return { queue, idle: idle.promise, get state() { return context.state; }, get pending() { return pending; }, get error() { return error; }, replaceContext(next) { context = next; } };
}
test('batch staging and unstaging only selected literal paths preserves other local edits', async t => {
  const root = await fixture(t); await writeFile(join(root, 'config.txt'), 'keep local\n');
  let state = await snapshot(root);
  state = (await mutate(root, 'set-staging', { revision: state.revision, paths: ['one.txt', 'two [中文].txt'], staged: true })).state;
  assert.deepEqual(state.files.filter(f => f.staged).map(f => f.path).sort(), ['one.txt', 'two [中文].txt']);
  state = (await mutate(root, 'set-staging', { revision: state.revision, paths: ['one.txt', 'two [中文].txt'], staged: false })).state;
  assert.ok(state.files.every(f => !f.staged)); assert.equal(await readFile(join(root, 'config.txt'), 'utf8'), 'keep local\n');
  assert.equal(await readFile(join(root, 'two [中文].txt'), 'utf8'), 'two [中文].txt\n');
});
test('unborn batch unstaging preserves every new file', async t => {
  const root = await fixture(t, false); let state = await snapshot(root);
  state = (await mutate(root, 'set-staging', { revision: state.revision, paths: ['one.txt', 'three.txt'], staged: true })).state;
  state = (await mutate(root, 'set-staging', { revision: state.revision, paths: ['one.txt', 'three.txt'], staged: false })).state;
  assert.ok(state.files.every(f => f.code === '??')); assert.equal(await readFile(join(root, 'one.txt'), 'utf8'), 'one.txt\n');
});
test('invalid and stale batches do not partially stage valid files', async t => {
  const root = await fixture(t), state = await snapshot(root);
  await assert.rejects(mutate(root, 'set-staging', { revision: state.revision, paths: ['one.txt', '../outside'], staged: true }), /文件已变化/);
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
  await writeFile(join(root, 'one.txt'), 'changed\n');
  await assert.rejects(mutate(root, 'set-staging', { revision: state.revision, paths: ['one.txt', 'three.txt'], staged: true }), /已变化/);
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
});
test('rapid selection and reversal uses confirmed revisions, queues other files and keeps final intent', async t => {
  const root = await fixture(t), state = await snapshot(root), entered = deferred(), release = deferred(), calls = [];
  let active = 0, peak = 0;
  const h = harness(root, state, async (id, args) => {
    active++; peak = Math.max(active, peak); calls.push(args);
    if (calls.length === 1) { entered.resolve(); await release.promise; }
    try { return await mutate(id, args.action, args); } finally { active--; }
  });
  const one = state.files.find(f => f.path === 'one.txt'); h.queue.enqueue([one], true);
  assert.ok(previewStaging(state.files, h.pending).find(f => f.path === 'one.txt').staged);
  await entered.promise;
  h.queue.enqueue([one], false); h.queue.enqueue(state.files.filter(f => f.path !== 'one.txt'), true);
  assert.equal(calls.length, 1); assert.equal(h.queue.size, 3);
  release.resolve(); await h.idle;
  assert.equal(peak, 1); assert.equal(h.error, ''); assert.equal(h.queue.size, 0);
  assert.deepEqual(h.state.files.filter(f => f.staged).map(f => f.path).sort(), ['three.txt', 'two [中文].txt']);
  assert.ok(h.state.files.find(f => f.path === 'one.txt').unstaged); assert.ok(new Set(calls.map(c => c.revision)).size > 1);
  assert.ok(calls.some(c => c.paths.length === 2));
});
test('stale queue write rolls back optimistic selection, reads actual state and stops queued work', async t => {
  const root = await fixture(t), state = await snapshot(root), entered = deferred(), release = deferred(); let calls = 0;
  const h = harness(root, state, async (id, args) => { calls++; entered.resolve(); await release.promise; return mutate(id, args.action, args); });
  h.queue.enqueue([state.files.find(f => f.path === 'one.txt')], true); await entered.promise;
  h.queue.enqueue([state.files.find(f => f.path === 'three.txt')], true); await writeFile(join(root, 'one.txt'), 'edited elsewhere\n');
  release.resolve(); await h.idle;
  assert.match(h.error, /已变化/); assert.equal(calls, 1); assert.equal(h.pending.length, 0); assert.ok(h.state.files.every(f => !f.staged));
  assert.notEqual(h.state.revision, state.revision); assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
});
test('late response cannot replace the state of another repository', async t => {
  const root = await fixture(t), second = await fixture(t), state = await snapshot(root), next = await snapshot(second), entered = deferred(), release = deferred();
  const h = harness(root, state, async (id, args) => { entered.resolve(); await release.promise; return mutate(id, args.action, args); });
  h.queue.enqueue([state.files[0]], true); await entered.promise; h.replaceContext({ id: second, state: next }); release.resolve(); await h.idle;
  assert.equal(h.state.root, second); assert.equal(h.state.revision, next.revision); assert.equal(h.pending.length, 0);
});
