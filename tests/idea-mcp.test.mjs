import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { git } from '../server/git.mjs';
import { changeGroups } from '../src/changes.js';

const base = fileURLToPath(new URL('../', import.meta.url)), scratch = join(base, '../../work/git-panel-qa');
async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'idea-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'MCP QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']);
  await writeFile(join(root, 'chosen.txt'), 'chosen base\n'); await writeFile(join(root, 'other.txt'), 'other base\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  const client = new Client({ name: 'git-panel-idea-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(base, 'server/mcp.mjs')], cwd: scratch, stderr: 'pipe' });
  await client.connect(transport); t.after(() => client.close());
  return { root, client };
}
async function call(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, undefined, response.content?.[0]?.text);
  return response.structuredContent;
}

test('IDEA MCP exposes 41 tools and commits only checked working-copy content after grouping', async t => {
  const { root, client } = await fixture(t), { tools } = await client.listTools();
  assert.equal(tools.length, 41);
  for (const name of ['git_changelist_action', 'git_commit_selected', 'git_generate_selected_message', 'git_list_shelves', 'git_shelf_diff', 'git_create_shelf', 'git_restore_shelf']) {
    assert.deepEqual(tools.find(tool => tool.name === name)?._meta.ui.visibility, ['app']);
  }
  await writeFile(join(root, 'chosen.txt'), 'chosen index\n'); await writeFile(join(root, 'other.txt'), 'other index\n'); await git(root, ['add', '.']);
  await writeFile(join(root, 'chosen.txt'), 'chosen latest working\n'); await writeFile(join(root, 'other.txt'), 'other latest working\n');
  let { id, state } = await call(client, 'git_open_repository', { root });
  const initialRevision = state.revision;
  ({ state } = await call(client, 'git_changelist_action', { id, revision: state.revision, op: 'create', name: '功能改动' }));
  assert.notEqual(state.revision, initialRevision);
  const groupId = state.changelists.groups.find(group => group.name === '功能改动').id;
  const stale = await client.callTool({ name: 'git_changelist_action', arguments: { id, revision: initialRevision, op: 'move', groupId, paths: ['chosen.txt'] } });
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /已变化/);
  ({ state } = await call(client, 'git_changelist_action', { id, revision: state.revision, op: 'move', groupId, paths: ['chosen.txt'] }));
  assert.equal(state.changelists.assignments['chosen.txt'], groupId);
  const result = await call(client, 'git_commit_selected', { id, revision: state.revision, paths: ['chosen.txt'], message: 'feat: 提交勾选改动' });
  assert.equal(await git(root, ['show', 'HEAD:chosen.txt']), 'chosen latest working\n');
  assert.equal(await git(root, ['show', 'HEAD:other.txt']), 'other base\n');
  assert.equal(await git(root, ['show', ':other.txt']), 'other index\n');
  assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other latest working\n');
  assert.deepEqual(result.state.files.map(file => [file.path, file.code]), [['other.txt', 'MM']]);
  assert.equal(Object.hasOwn(result.state.changelists.assignments, 'chosen.txt'), false);
});

test('IDEA MCP shelves preview and restore selected files into the chosen changelist', async t => {
  const { root, client } = await fixture(t);
  await writeFile(join(root, 'chosen.txt'), 'shelved tracked edit\n'); await writeFile(join(root, 'new-file.txt'), 'shelved new file\n');
  await writeFile(join(root, 'other.txt'), 'unrelated staged\n'); await git(root, ['add', 'other.txt']);
  await writeFile(join(root, 'other.txt'), 'unrelated work\n');
  let { id, state } = await call(client, 'git_open_repository', { root });
  ({ state } = await call(client, 'git_changelist_action', { id, revision: state.revision, op: 'create', name: '恢复到这里' }));
  const groupId = state.changelists.groups.at(-1).id;
  const created = await call(client, 'git_create_shelf', { id, revision: state.revision, paths: ['chosen.txt', 'new-file.txt'], groupId, name: '待继续的功能' });
  assert.equal(created.status, 'success'); assert.deepEqual(created.state.files.map(file => file.path), ['other.txt']);
  const listed = await call(client, 'git_list_shelves', { id }); assert.equal(listed.shelves.length, 1); assert.equal(listed.shelves[0].id, created.shelf.id);
  const preview = await call(client, 'git_shelf_diff', { id, shelfId: created.shelf.id, path: 'new-file.txt' }); assert.match(preview.patch, /shelved new file/);
  const restored = await call(client, 'git_restore_shelf', { id, revision: created.state.revision, shelfId: created.shelf.id, paths: ['chosen.txt'], groupId });
  assert.equal(restored.status, 'success'); assert.equal(restored.state.changelists.assignments['chosen.txt'], groupId);
  await assert.rejects(readFile(join(root, 'new-file.txt')), { code: 'ENOENT' });
  const newFile = await call(client, 'git_restore_shelf', { id, revision: restored.state.revision, shelfId: created.shelf.id, paths: ['new-file.txt'], groupId });
  const visibleGroup = changeGroups(newFile.state.files, newFile.state.changelists).find(group => group.files.some(file => file.path === 'new-file.txt'));
  assert.equal(visibleGroup.id, groupId, 'explicit restored new-file target must match the visible group');
  assert.equal(await readFile(join(root, 'new-file.txt'), 'utf8'), 'shelved new file\n');
  assert.equal(await git(root, ['show', ':other.txt']), 'unrelated staged\n'); assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'unrelated work\n');
  assert.equal((await call(client, 'git_list_shelves', { id })).shelves.length, 1, 'restore keeps the shelf backup');
});

test('IDEA MCP watcher wakes for group metadata changes and state revision invalidates stale requests', async t => {
  const { root, client } = await fixture(t);
  const { id, state } = await call(client, 'git_open_repository', { root });
  const listener = 'idea-metadata-watch';
  const first = await call(client, 'git_wait_changes', { id, client: listener });
  let timer;
  try {
    const waiting = call(client, 'git_wait_changes', { id, client: listener, version: first.version });
    const changed = await call(client, 'git_changelist_action', { id, revision: state.revision, op: 'create', name: '另一面板的分组' });
    assert.notEqual(changed.state.revision, state.revision);
    const event = await Promise.race([waiting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('metadata watcher did not wake within 8 seconds')), 8000); })]);
    assert.equal(event.changed, true); assert.notEqual(event.version, first.version);
    const latest = await call(client, 'git_repository_state', { id });
    assert.equal(latest.revision, changed.state.revision); assert.equal(latest.changelists.groups.at(-1).name, '另一面板的分组');
  } finally { clearTimeout(timer); await call(client, 'git_stop_watching', { id, client: listener }); }
});
