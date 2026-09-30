import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, snapshot, mutate } from '../server/git.mjs';
import { branchList } from '../server/branches.mjs';
import { withLocalChanges } from '../server/local-changes.mjs';
const scratch = new URL('../../../work/git-panel-qa/', import.meta.url).pathname;
async function fixture(t, conflict = false) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(join(scratch, 'auto-save-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Auto Save QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']);
  await writeFile(join(root, 'a.txt'), 'base\n'); await writeFile(join(root, 'config.txt'), 'base one\nbase two\n'); await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']); await git(root, ['switch', '-c', 'topic']);
  await writeFile(join(root, conflict ? 'a.txt' : 'topic.txt'), 'topic\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'topic']); await git(root, ['switch', 'main']);
  return root;
}
async function merge(root) {
  const data = await branchList(root), target = data.branches.find(b => b.name === 'topic');
  return mutate(root, 'merge', { revision: data.state.revision, ref: target.ref, targetOid: target.oid });
}
test('preserves a partial index, binary edit, many special untracked paths and existing user stash', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'config.txt'), 'user stash\n'); await git(root, ['stash', 'push', '-m', 'user-owned-stash'], { literalPathspecs: false });
  const userOid = (await git(root, ['rev-parse', 'refs/stash'])).trim();
  await writeFile(join(root, 'config.txt'), 'staged one\nbase two\n'); await git(root, ['add', 'config.txt']);
  await writeFile(join(root, 'config.txt'), 'staged one\nunstaged two\n'); await writeFile(join(root, 'binary.bin'), Buffer.from([0, 9, 8, 7]));
  for (let i = 0; i < 25; i++) await writeFile(join(root, `notes [${i}].txt`), `private ${i}\n`);
  const index = await git(root, ['diff', '--cached', '--binary']), work = await git(root, ['diff', '--binary']);
  const result = await merge(root); assert.equal(result.status, 'success'); assert.equal(result.state.operation, null);
  assert.equal(await git(root, ['diff', '--cached', '--binary']), index); assert.equal(await git(root, ['diff', '--binary']), work);
  assert.deepEqual(await readFile(join(root, 'binary.bin')), Buffer.from([0, 9, 8, 7]));
  for (let i = 0; i < 25; i++) assert.equal(await readFile(join(root, `notes [${i}].txt`), 'utf8'), `private ${i}\n`);
  assert.equal(await git(root, ['show', 'HEAD:config.txt']), 'base one\nbase two\n');
  assert.ok((await git(root, ['stash', 'list', '--format=%H'])).includes(userOid));
});
test('operation failure restores the worktree and index before reporting failure', async t => {
  const root = await fixture(t); await writeFile(join(root, 'config.txt'), 'staged local\n'); await git(root, ['add', 'config.txt']); await writeFile(join(root, 'notes.txt'), 'notes\n');
  const before = await snapshot(root);
  await assert.rejects(withLocalChanges(root, before, () => git(root, ['merge', '--', 'nonexistent-ref'])), /not something we can merge/);
  const after = await snapshot(root); assert.equal(after.operation, null); assert.equal(after.head, before.head);
  assert.equal(await git(root, ['show', ':config.txt']), 'staged local\n'); assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'notes\n');
});
test('fresh server process recognizes pending backup after external abort and retries exact stash', async t => {
  const root = await fixture(t, true); await writeFile(join(root, 'a.txt'), 'main\n'); await git(root, ['add', 'a.txt']); await git(root, ['commit', '-m', 'main']);
  await writeFile(join(root, 'config.txt'), 'local config\n'); await writeFile(join(root, 'notes.txt'), 'notes\n');
  const result = await merge(root); assert.equal(result.status, 'conflict'); const oid = result.state.operation.localBackup.oid;
  await git(root, ['merge', '--abort']);
  // Another user stash must not change which backup is restored.
  await writeFile(join(root, 'later.txt'), 'later\n'); await git(root, ['stash', 'push', '-u', '-m', 'another-user-stash'], { literalPathspecs: false });
  const script = "import {snapshot} from './server/git.mjs'; console.log(JSON.stringify(await snapshot(process.argv[1])))";
  const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root], { cwd: new URL('../', import.meta.url).pathname });
  const state = JSON.parse(output.stdout); assert.equal(state.operation.type, 'local-restore'); assert.equal(state.operation.localBackup.oid, oid);
  const restored = await mutate(root, 'restore-retry', { revision: state.revision }); assert.equal(restored.state.operation, null);
  assert.equal(await readFile(join(root, 'config.txt'), 'utf8'), 'local config\n'); assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'notes\n');
  assert.match(await git(root, ['stash', 'list']), /another-user-stash/);
});
