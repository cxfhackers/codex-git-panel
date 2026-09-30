import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPath } from '../src/selection.js';

const visible = ['one', 'two', 'three', 'four', 'five'];

test('plain click selects one; Shift includes the whole visible range and keeps its anchor', () => {
  const first = selectPath(visible, new Set(), null, 'one');
  const ranged = selectPath(visible, first.paths, first.anchor, 'four', { shift: true });
  assert.deepEqual([...ranged.paths], ['one', 'two', 'three', 'four']);
  assert.equal(ranged.anchor, 'one');
  const shorter = selectPath(visible, ranged.paths, ranged.anchor, 'three', { shift: true });
  assert.deepEqual([...shorter.paths], ['one', 'two', 'three']);
});

test('Ctrl or Command toggles isolated paths, including deselection', () => {
  const first = selectPath(visible, new Set(), null, 'one');
  const added = selectPath(visible, first.paths, first.anchor, 'five', { additive: true });
  assert.deepEqual([...added.paths], ['one', 'five']);
  const removed = selectPath(visible, added.paths, added.anchor, 'one', { additive: true });
  assert.deepEqual([...removed.paths], ['five']);
});

test('Shift works over the filtered visible list and never spans a hidden anchor', () => {
  const filtered = ['one', 'three', 'five'];
  const selected = selectPath(filtered, new Set(), 'two', 'five', { shift: true });
  assert.deepEqual([...selected.paths], ['five']);
  const range = selectPath(filtered, selected.paths, 'one', 'five', { shift: true });
  assert.deepEqual([...range.paths], filtered);
  const union = selectPath(filtered, new Set(['elsewhere']), 'one', 'three', { shift: true, additive: true });
  assert.deepEqual([...union.paths], ['elsewhere', 'one', 'three']);
});
