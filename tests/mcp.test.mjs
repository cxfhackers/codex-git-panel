import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { git } from '../server/git.mjs';
import { conflictParts, mergeChoices } from '../src/conflicts.js';

const base = fileURLToPath(new URL('../', import.meta.url));
const scratch = join(base, '../../work/git-panel-qa');
async function clientFor(t) {
  await mkdir(scratch, { recursive: true });
  const client = new Client({ name: 'git-panel-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(base, 'server/mcp.mjs')], cwd: scratch, stderr: 'pipe' });
  await client.connect(transport); t.after(() => client.close()); return client;
}
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  return r.structuredContent;
}
test('MCP exposes one thread entrypoint and a self-contained UI with no network domains', async t => {
  const c = await clientFor(t), { tools } = await c.listTools();
  const launchers = tools.filter(x => x._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'thread'));
  assert.equal(launchers.length, 1); assert.equal(launchers[0].title, 'Git 提交');
  assert.equal(launchers[0]._meta.ui.resourceUri, 'ui://git-panel/0.10.0/main.html');
  const resource = await c.readResource({ uri: launchers[0]._meta.ui.resourceUri });
  const html = resource.contents[0];
  assert.equal(html.mimeType, 'text/html;profile=mcp-app');
  assert.match(html.text, /__GIT_PANEL_MCP__=true/);
  assert.doesNotMatch(html.text, /<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"/);
  assert.deepEqual(html._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.deepEqual(tools.find(x => x.name === 'git_commit_staged')._meta.ui.visibility, ['app']);
  assert.equal(tools.find(x => x.name === 'git_commit_staged').annotations.readOnlyHint, false);
  assert.equal(tools.length, 41);
  assert.equal(tools.find(x => x.name === 'git_conflict_versions').annotations.readOnlyHint, true);
  assert.equal(tools.find(x => x.name === 'git_suggest_conflict_merge').annotations.openWorldHint, true);
  assert.equal(tools.find(x => x.name === 'git_apply_conflict_merge').annotations.readOnlyHint, false);
  for (const name of ['git_switch_branch', 'git_merge_branch', 'git_continue_merge', 'git_abort_merge', 'git_resolve_conflict_file']) {
    assert.deepEqual(tools.find(x => x.name === name)._meta.ui.visibility, ['app']);
    assert.equal(tools.find(x => x.name === name).annotations.readOnlyHint, false);
  }
  assert.equal(tools.find(x => x.name === 'git_abort_merge').annotations.destructiveHint, true);
  const data = await call(c, 'open_git_panel'); assert.ok(Array.isArray(data.projects));
  assert.ok(data.project.key); assert.equal(data.project.cwd, scratch);
  assert.equal(data.projects.some(p => p.root.endsWith('/ibms-service')), false);
});
test('MCP conflict tools read three versions and apply a reviewed file without committing', async t => {
  const c = await clientFor(t), parent = join(base, '../../work/git-panel-qa'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'conflict-mcp-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'MCP QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']); await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']);
  await writeFile(join(root, 'file.js'), 'const value = 0;\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'base']);
  await git(root, ['switch', '-c', 'incoming']); await writeFile(join(root, 'file.js'), 'const value = 20;\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'incoming']);
  await git(root, ['switch', 'main']); await writeFile(join(root, 'file.js'), 'const value = 10;\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'current']); await assert.rejects(git(root, ['merge', '--no-edit', 'incoming']));
  const opened = await call(c, 'git_open_repository', { root });
  const preview = await call(c, 'git_conflict_versions', { id: opened.id, revision: opened.state.revision, path: 'file.js' });
  assert.equal(preview.count, 1);
  const result = await call(c, 'git_apply_conflict_merge', { id: opened.id, revision: preview.state.revision, path: 'file.js', token: preview.token, content: mergeChoices(conflictParts(preview.automatic), { 0: 'const value = 30;\n' }), deleted: false });
  assert.equal(result.status, 'success'); assert.equal(result.state.head, opened.state.head); assert.equal(result.state.files[0].staged, true); assert.equal(await git(root, ['show', ':file.js']), 'const value = 30;\n');
});
test('MCP branch tools list, preview, switch, and merge using confirmed ref tips', async t => {
  const c = await clientFor(t), parent = join(base, '../../work/git-panel-qa'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'branch-mcp-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'MCP QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'base.txt'), 'initial\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  await git(root, ['switch', '-c', 'feature']); await writeFile(join(root, 'feature.txt'), 'feature\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'feature']); await git(root, ['switch', 'main']);
  const { id } = await call(c, 'git_open_repository', { root });
  let list = await call(c, 'git_branch_list', { id });
  const feature = list.branches.find(b => b.name === 'feature');
  const preview = await call(c, 'git_merge_preview', { id, revision: list.state.revision, ref: feature.ref, targetOid: feature.oid });
  assert.equal(preview.incoming, 1);
  const switched = await call(c, 'git_switch_branch', { id, revision: list.state.revision, ref: feature.ref, targetOid: feature.oid });
  assert.equal(switched.state.branch, 'feature');
  list = await call(c, 'git_branch_list', { id }); const main = list.branches.find(b => b.name === 'main');
  await call(c, 'git_switch_branch', { id, revision: list.state.revision, ref: main.ref, targetOid: main.oid });
  list = await call(c, 'git_branch_list', { id });
  const merged = await call(c, 'git_merge_branch', { id, revision: list.state.revision, ref: feature.ref, targetOid: feature.oid });
  assert.equal(merged.state.branch, 'main'); assert.equal(merged.state.head, feature.oid); assert.equal(merged.status, 'success');
});
test('switching frontend and backend reuses connections and keeps their Git indexes separate', async t => {
  const c = await clientFor(t);
  const parent = join(base, '../../work/git-panel-qa'); await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, 'switch-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  const back = join(workspace, 'backend'), front = join(workspace, 'frontend');
  for (const [root, filename] of [[back, 'service.txt'], [front, 'page.txt']]) {
    await mkdir(root); await git(root, ['init', '-b', 'switch-qa']);
    await git(root, ['config', 'user.name', 'MCP QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    await writeFile(join(root, filename), 'initial\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
    await writeFile(join(root, filename), `changed ${filename}\n`);
  }
  const backend = await call(c, 'git_open_repository', { root: back });
  await call(c, 'git_stage_file', { id: backend.id, revision: backend.state.revision, path: 'service.txt' });
  const frontend = await call(c, 'git_open_repository', { root: front });
  assert.notEqual(frontend.id, backend.id); assert.equal(frontend.state.root, front);
  assert.deepEqual(frontend.state.files.map(f => f.path), ['page.txt']);
  assert.equal(frontend.state.files[0].staged, false);
  const stale = await c.callTool({ name: 'git_stage_file', arguments: { id: frontend.id, revision: backend.state.revision, path: 'page.txt' } });
  assert.equal(stale.isError, true);
  const again = await call(c, 'git_open_repository', { root: back });
  assert.equal(again.id, backend.id); assert.equal(again.state.files[0].path, 'service.txt');
  assert.equal(again.state.files[0].staged, true);
  assert.equal((await call(c, 'git_open_repository', { root: front })).id, frontend.id);
});
test('MCP Git workflow commits only selected file and rejects stale revisions and invalid connections', async t => {
  const c = await clientFor(t);
  const parent = join(base, '../../work/git-panel-qa'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'mcp-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'mcp-qa']);
  await git(root, ['config', 'user.name', 'MCP QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
  await writeFile(join(root, 'selected.md'), 'initial\n'); await writeFile(join(root, 'leave.txt'), 'initial\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  await writeFile(join(root, 'selected.md'), 'changed\n'); await writeFile(join(root, 'leave.txt'), 'leave untouched\n');
  let { id, state } = await call(c, 'git_open_repository', { root });
  const patch = await call(c, 'git_file_diff', { id, path: 'selected.md', staged: false });
  assert.match(patch.patch, /\+changed/);
  const oldRevision = state.revision;
  ({ state } = await call(c, 'git_stage_file', { id, revision: state.revision, path: 'selected.md' }));
  const stale = await c.callTool({ name: 'git_stage_file', arguments: { id, revision: oldRevision, path: 'leave.txt' } });
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /已变化/);
  const generated = { message: 'docs: 更新选中的说明' };
  await call(c, 'git_commit_staged', { id, revision: state.revision, message: generated.message });
  assert.equal((await git(root, ['show', 'HEAD:selected.md'])).trim(), 'changed');
  assert.equal((await git(root, ['show', 'HEAD:leave.txt'])).trim(), 'initial');
  assert.match(await git(root, ['status', '--porcelain']), / M leave.txt/);
  const invalid = await c.callTool({ name: 'git_repository_state', arguments: { id: 'f'.repeat(24) } });
  assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /失效/);
});
test('MCP protects selected files and edits their worktree content without staging', async t => {
  const c = await clientFor(t), root = await mkdtemp(join(scratch, 'workspace-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await writeFile(join(root, 'local.txt'), 'local\n'); await writeFile(join(root, 'public.txt'), 'public\n');
  const { id, state } = await call(c, 'git_open_repository', { root });
  let result = await call(c, 'git_set_exclusions', { id, revision: state.revision, rules: [{ type: 'file', path: 'local.txt' }] });
  assert.equal(result.state.files.find(f => f.path === 'local.txt').excluded, true);
  const denied = await c.callTool({ name: 'git_stage_file', arguments: { id, revision: result.state.revision, path: 'local.txt' } });
  assert.equal(denied.isError, true);
  const file = await call(c, 'git_read_editable_file', { id, path: 'local.txt' });
  result = await call(c, 'git_save_file', { id, path: file.path, token: file.token, content: 'saved in panel\n' });
  assert.equal(result.file.content, 'saved in panel\n'); assert.equal(result.state.files.find(f => f.path === 'local.txt').staged, false);
  const watch = await call(c, 'git_wait_changes', { id, client: 'mcp-watch-test' }); assert.equal(typeof watch.version, 'string');
  await call(c, 'git_stop_watching', { id, client: 'mcp-watch-test' });
  result = await call(c, 'git_set_exclusions', { id, revision: result.state.revision, rules: [] });
  result = await call(c, 'git_set_files_staged', { id, revision: result.state.revision, paths: ['local.txt'], staged: true });
  assert.equal(result.state.files.find(f => f.path === 'local.txt').staged, true);
});
