import { collectStaged } from '../server/ai.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, snapshot, mutate } from '../server/git.mjs';
import { readEditable, saveEditable } from '../server/editor.mjs';
import { waitForChanges, stopWatching } from '../server/watch.mjs';
async function fixture(t, commit = true) {
  const root = await mkdtemp(join(tmpdir(), 'git-panel-features-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Canonical root matches real repository() behavior on macOS (/tmp -> /private/tmp).
  const { realpath } = await import('node:fs/promises'); const canonical = await realpath(root);
  await git(canonical, ['init', '-b', 'main']); await git(canonical, ['config', 'user.name', 'QA']); await git(canonical, ['config', 'user.email', 'qa@example.test']); await git(canonical, ['config', 'commit.gpgsign', 'false']);
  await mkdir(join(canonical, 'local')); await writeFile(join(canonical, 'local/中文.txt'), 'original\n'); await writeFile(join(canonical, 'app.txt'), 'base\n');
  if (commit) { await git(canonical, ['add', '.']); await git(canonical, ['commit', '-m', 'base']); }
  return canonical;
}
async function act(root, action, body) { return mutate(root, action, { revision: (await snapshot(root)).revision, ...body }); }
test('directory protection persists and covers future files; all staging paths are guarded', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'local/中文.txt'), 'private\n'); await git(root, ['add', '.']);
  let result = await act(root, 'exclusions', { rules: [{ type: 'directory', path: 'local' }] });
  assert.equal(result.state.files[0].staged, false); assert.equal(result.state.files[0].excluded, true);
  assert.equal(await readFile(join(root, 'local/中文.txt'), 'utf8'), 'private\n');
  await mkdir(join(root, 'local/nested')); await writeFile(join(root, 'local/nested/new.txt'), 'never\n');
  await writeFile(join(root, 'app.txt'), 'public\n');
  assert.equal((await snapshot(root)).files.find(f => f.path.endsWith('new.txt')).excluded, true);
  for (const [action, body] of [['stage', { path: 'local/中文.txt' }], ['hunk', { path: 'local/中文.txt', hunk: 0, staged: false }], ['set-staging', { paths: ['app.txt', 'local/中文.txt'], staged: true }]]) await assert.rejects(act(root, action, body), /永不提交/);
  assert.equal((await snapshot(root)).files.some(f => f.staged), false);
  // External staging cannot bypass the panel's commit protection.
  await git(root, ['add', '.']); result = await act(root, 'commit', { message: 'public only' });
  assert.equal(await git(root, ['show', 'HEAD:app.txt']), 'public\n');
  assert.equal(await git(root, ['show', 'HEAD:local/中文.txt']), 'original\n');
  assert.ok(result.state.files.every(f => !f.staged && f.excluded));
  await git(root, ['switch', '-c', 'another']); assert.equal((await snapshot(root)).exclusions.length, 1);
  await act(root, 'exclusions', { rules: [] }); await act(root, 'stage', { path: 'local/中文.txt' });
  assert.equal((await snapshot(root)).files.find(f => f.path === 'local/中文.txt').staged, true);
});
test('AI input excludes externally staged protected files without changing the index', async t => {
  const root = await fixture(t);
  await act(root, 'exclusions', { rules: [{ type: 'directory', path: 'local' }] });
  await writeFile(join(root, 'local/中文.txt'), 'private content\n'); await writeFile(join(root, 'app.txt'), 'public change\n'); await git(root, ['add', '.']);
  const before = await snapshot(root); const data = await collectStaged(root, before);
  assert.deepEqual(data.files.map(f => f.path), ['app.txt']); assert.doesNotMatch(data.patch, /private content|local\//);
  assert.equal((await snapshot(root)).revision, before.revision);
});
test('protection handles unborn repositories, renames, literal filenames and rule validation', async t => {
  const root = await fixture(t, false); await git(root, ['add', '.']);
  await act(root, 'exclusions', { rules: [{ type: 'file', path: 'local/中文.txt' }] });
  assert.equal(await readFile(join(root, 'local/中文.txt'), 'utf8'), 'original\n');
  assert.equal((await snapshot(root)).files.find(f => f.path === 'local/中文.txt').staged, false);
  await act(root, 'exclusions', { rules: [] }); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  await git(root, ['mv', 'app.txt', 'renamed.txt']);
  await act(root, 'exclusions', { rules: [{ type: 'file', path: 'app.txt' }] });
  assert.equal((await snapshot(root)).files.find(f => f.path === 'app.txt').staged, false);
  assert.equal(await readFile(join(root, 'renamed.txt'), 'utf8'), 'base\n');
  await assert.rejects(act(root, 'exclusions', { rules: [{ type: 'directory', path: '../outside' }] }), /相对/);
});
test('protecting a staged rename covers both sides after unstaging', async t => {
  const root = await fixture(t); await git(root, ['mv', 'app.txt', 'renamed.txt']);
  const result = await act(root, 'exclusions', { rules: [{ type: 'file', path: 'renamed.txt' }] });
  assert.ok(result.state.files.filter(f => ['app.txt', 'renamed.txt'].includes(f.path)).every(f => f.excluded && !f.staged));
  await assert.rejects(act(root, 'stage', { path: 'app.txt' }), /永不提交/);
});
test('moving a partially staged unborn file to the group preserves its latest content', async t => {
  const root = await fixture(t, false); await git(root, ['add', '.']); await writeFile(join(root, 'app.txt'), 'latest\n');
  const result = await act(root, 'exclusions', { rules: [{ type: 'file', path: 'app.txt' }] });
  assert.equal(result.state.files.find(f => f.path === 'app.txt').staged, false);
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'latest\n');
});
test('moving a file out of a directory group affects only that file', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'local/中文.txt'), 'changed\n'); await writeFile(join(root, 'local/other.txt'), 'other\n');
  await act(root, 'exclusions', { rules: [{ type: 'directory', path: 'local' }] });
  let result = await act(root, 'exclusions', { rules: [{ type: 'directory', path: 'local' }, { type: 'file', path: 'local/中文.txt', excluded: false }] });
  assert.equal(result.state.files.find(f => f.path === 'local/中文.txt').excluded, false);
  assert.equal(result.state.files.find(f => f.path === 'local/other.txt').excluded, true);
  await act(root, 'stage', { path: 'local/中文.txt' });
  await assert.rejects(act(root, 'stage', { path: 'local/other.txt' }), /永不提交/);
});
test('editor preserves index, Unicode BOM CRLF and executable permissions; stale saves fail', async t => {
  const root = await fixture(t), path = 'app.txt';
  await writeFile(join(root, path), '\ufeff中文\r\n'); await chmod(join(root, path), 0o755); await git(root, ['add', path]);
  const index = await git(root, ['show', ':app.txt']); const opened = await readEditable(root, path);
  await saveEditable(root, { path, token: opened.token, content: '\ufeff修改\n' });
  assert.equal(await readFile(join(root, path), 'utf8'), '\ufeff修改\r\n'); assert.equal((await stat(join(root, path))).mode & 0o777, 0o755);
  assert.equal(await git(root, ['show', ':app.txt']), index);
  await assert.rejects(saveEditable(root, { path, token: opened.token, content: 'stale' }), /外部修改/);
  assert.equal(await readFile(join(root, path), 'utf8'), '\ufeff修改\r\n');
});
test('editor rejects traversal, Git metadata, symlinks, binaries and oversized files', async t => {
  const root = await fixture(t);
  await symlink('app.txt', join(root, 'linked.txt')); await symlink('local', join(root, 'linked-dir'));
  await writeFile(join(root, 'binary'), Buffer.from([0, 255])); await writeFile(join(root, 'big'), 'x'.repeat(524289));
  for (const path of ['../outside', '.git/config', 'linked.txt', 'linked-dir/中文.txt', 'binary', 'big']) await assert.rejects(readEditable(root, path));
});
test('watch detects tracked, new nested and externally staged files; stop releases watches', async t => {
  const root = await fixture(t); const client = 'test-watch'; t.after(() => stopWatching(root, client));
  let result = await waitForChanges(root, { client }); assert.equal(result.degraded, false);
  let pending = waitForChanges(root, { client, version: result.version });
  await writeFile(join(root, 'app.txt'), 'changed\n'); result = await pending; assert.equal(result.changed, true);
  pending = waitForChanges(root, { client, version: result.version });
  await mkdir(join(root, 'newdir')); await writeFile(join(root, 'newdir/new.txt'), 'new\n'); result = await pending; assert.equal(result.changed, true);
  pending = waitForChanges(root, { client, version: result.version });
  await git(root, ['add', '.']); result = await pending; assert.equal(result.changed, true);
  pending = waitForChanges(root, { client, version: result.version }); await stopWatching(root, client); assert.equal((await pending).closed, true);
});
test('watch ignores dependency churn and status reads do not create a refresh loop', async t => {
  const root = await fixture(t); await writeFile(join(root, '.gitignore'), 'node_modules/\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'ignore']);
  const client = 'idle-test'; t.after(() => stopWatching(root, client));
  const initial = await waitForChanges(root, { client }); const pending = waitForChanges(root, { client, version: initial.version });
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/x'), 'generated'); await snapshot(root);
  const next = await pending; assert.equal(next.changed, false);
});
