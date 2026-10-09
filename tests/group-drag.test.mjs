import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDropPaths, autoAddPaths } from '../src/changes.js';

const state = {
  root: '/repo',
  files: [
    { path: 'one.txt', code: ' M' },
    { path: 'two.txt', code: ' M' },
    { path: 'local.txt', code: ' M', excluded: true },
    { path: 'new.txt', code: '??' },
    { path: 'added.txt', code: 'AM' },
    { path: 'protected-new.txt', code: '??', excluded: true },
    { path: 'conflict.txt', code: 'UU', conflict: true },
  ],
  changelists: { groups: [{ id: 'changes', name: '更改' }, { id: 'later', name: '稍后' }], activeId: 'changes', assignments: { 'two.txt': 'later' } },
};
const drag = (...paths) => ({ root: '/repo', paths });

test('multi-selection moves only files outside the target group, once each', () => {
  assert.deepEqual(groupDropPaths(state, drag('one.txt', 'two.txt', 'one.txt'), 'later'), ['one.txt']);
  assert.deepEqual(groupDropPaths(state, drag('one.txt'), 'changes'), []);
});
test('protected and untracked files can move into ordinary groups; ordinary files can be protected', () => {
  assert.deepEqual(groupDropPaths(state, drag('local.txt', 'new.txt'), 'later'), ['local.txt', 'new.txt']);
  assert.deepEqual(groupDropPaths(state, drag('one.txt', 'local.txt'), 'excluded'), ['one.txt']);
});
test('invalid target never untracks files or accepts a nonexistent group', () => {
  for (const id of ['unversioned', 'deleted-group']) assert.deepEqual(groupDropPaths(state, drag('one.txt'), id), []);
});
test('unversioned target accepts staged additions and protected new files but rejects mixed tracked selections', () => {
  assert.deepEqual(groupDropPaths(state, drag('added.txt', 'protected-new.txt', 'new.txt'), 'unversioned'), ['added.txt', 'protected-new.txt']);
  assert.deepEqual(groupDropPaths(state, drag('added.txt', 'one.txt'), 'unversioned'), []);
});
test('auto-add respects explicit unversioned choices while still adding other new files', () => {
  const next = { ...state, files: [...state.files, { path: 'other-new.txt', code: '??' }], changelists: { ...state.changelists, manualUntracked: ['new.txt'] } };
  assert.deepEqual(autoAddPaths(next), ['other-new.txt']);
});
test('repository switches and operations in progress cancel a pending drag', () => {
  assert.deepEqual(groupDropPaths({ ...state, root: '/other' }, drag('one.txt'), 'later'), []);
  assert.deepEqual(groupDropPaths(state, drag('one.txt'), 'later', true), []);
  assert.deepEqual(groupDropPaths(null, drag('one.txt'), 'later'), []);
});
test('stale, conflicted, or malformed selections cannot partially move', () => {
  for (const data of [null, {}, drag(), drag('one.txt', 'removed.txt'), drag('one.txt', 'conflict.txt'), { root: '/repo', paths: 'one.txt' }]) {
    assert.deepEqual(groupDropPaths(state, data, 'later'), []);
  }
});
