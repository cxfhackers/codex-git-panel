import { readComparison } from './editor-compare.mjs';
import { listShelves, shelfDiff } from './shelves.mjs';
import { waitForChanges, stopWatching } from './watch.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { repository, snapshot, diff, mutate } from './git.mjs';
import { session, scopedRepository } from './projects.mjs';
import { syncTargets } from './sync.mjs';
import { branchList, mergePreview } from './branches.mjs';
import { conflictPreview } from './conflicts.mjs';

const uri = 'ui://git-panel/0.10.0/main.html';
const server = new McpServer({ name: 'codex-git-panel', title: 'Git 提交', version: '0.10.0' });
const repos = new Map(), locks = new Map();
const repoFields = { id: z.string().regex(/^[a-f0-9]{24}$/) };
const revisionFields = { ...repoFields, revision: z.string().regex(/^[a-f0-9]{64}$/) };
const fileFields = { ...revisionFields, path: z.string().min(1) };
const branchFields = { ...revisionFields, ref: z.string().regex(/^refs\/(heads|remotes)\//).max(1024), targetOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) };
const appMeta = {
  ui: { resourceUri: uri, visibility: ['app'] },
  'openai/widgetAccessible': true,
};
function result(data, message = '操作完成') {
  return { content: [{ type: 'text', text: message }], structuredContent: data };
}
function register(name, title, inputSchema, readOnly, callback, extra = {}) {
  server.registerTool(name, {
    title, description: title, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false, ...extra },
    _meta: appMeta,
  }, async (args) => {
    try { return result(await callback(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}
function rootFor(id) {
  const root = repos.get(id);
  if (!root) throw new Error('仓库连接已失效，请重新选择仓库');
  return root;
}
async function action(name, args) {
  const root = rootFor(args.id);
  const previous = locks.get(root) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => mutate(root, name, args));
  locks.set(root, task);
  try { return await task; }
  finally { if (locks.get(root) === task) locks.delete(root); }
}

async function panelResource(requestUri) { return {
  contents: [{
    uri: requestUri, mimeType: 'text/html;profile=mcp-app',
    text: await readFile(new URL('../dist-mcp/index.html', import.meta.url), 'utf8'),
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
  }],
}; }
server.registerResource('git-panel', uri, { mimeType: 'text/html;profile=mcp-app' }, () => panelResource(uri));
server.registerResource('git-panel-0.9.0', 'ui://git-panel/0.9.0/main.html', { mimeType: 'text/html;profile=mcp-app' }, () => panelResource('ui://git-panel/0.9.0/main.html'));
server.registerResource('git-panel-0.8.7', 'ui://git-panel/0.8.7/main.html', { mimeType: 'text/html;profile=mcp-app' }, () => panelResource('ui://git-panel/0.8.7/main.html'));
server.registerResource('git-panel-0.8.6', 'ui://git-panel/0.8.6/main.html', { mimeType: 'text/html;profile=mcp-app' }, () => panelResource('ui://git-panel/0.8.6/main.html'));
server.registerResource('git-panel-0.8.5', 'ui://git-panel/0.8.5/main.html', { mimeType: 'text/html;profile=mcp-app' }, () => panelResource('ui://git-panel/0.8.5/main.html'));
server.registerResource('git-panel-0.8.4', 'ui://git-panel/0.8.4/main.html', { mimeType: 'text/html;profile=mcp-app' }, () => panelResource('ui://git-panel/0.8.4/main.html'));
server.registerResource('git-panel-0.8.3', 'ui://git-panel/0.8.3/main.html', { mimeType: 'text/html;profile=mcp-app' }, () => panelResource('ui://git-panel/0.8.3/main.html'));
server.registerResource('git-panel-legacy', 'ui://git-panel/main.html', { mimeType: 'text/html;profile=mcp-app' }, () => panelResource('ui://git-panel/main.html'));
server.registerTool('open_git_panel', {
  title: 'Git 提交', description: '在侧边栏打开本机 Git 提交面板。查看和编辑文件差异、按分组勾选提交、搁置恢复。',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: uri }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
}, async () => result(session, 'Git 提交面板已准备好，仓库范围来自当前项目。'));
register('git_panel_session', '获取 Git 面板项目列表', {}, true, async () => session);
register('git_open_repository', '读取用户选定的本机 Git 仓库', { root: z.string().startsWith('/') }, true, async ({ root: input }) => {
  const root = await scopedRepository(input, session);
  const knownId = [...repos].find(([, knownRoot]) => knownRoot === root)?.[0];
  if (!knownId && repos.size >= 64) throw new Error('打开的仓库过多，请关闭并重新打开面板');
  const id = knownId || randomBytes(12).toString('hex'), state = await snapshot(root);
  repos.set(id, root); return { id, state };
});
register('git_repository_state', '读取 Git 状态', repoFields, true, async ({ id }) => snapshot(rootFor(id)));
register('git_read_editable_file', '读取仓库内文本文件用于编辑', { ...repoFields, path: z.string().min(1) }, true, ({ id, path }) => readComparison(rootFor(id), path));
register('git_save_file', '保存文件草稿，校验磁盘版本并保留暂存内容', { ...repoFields, path: z.string().min(1), token: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().max(524288) }, false, args => action('file-save', args));
register('git_set_exclusions', '设置本仓库永不提交文件及目录规则，并移出暂存区', { ...revisionFields, rules: z.array(z.object({ path: z.string().min(1), type: z.enum(['file', 'directory']), excluded: z.boolean().optional() })).max(2000) }, false, args => action('exclusions', args));
register('git_wait_changes', '等待本地文件变化，无变化时不扫描仓库', { ...repoFields, client: z.string().max(80), version: z.string().max(80).optional() }, true, ({ id, ...args }) => waitForChanges(rootFor(id), args));
register('git_stop_watching', '释放当前面板的文件监听', { ...repoFields, client: z.string().max(80) }, true, ({ id, client }) => stopWatching(rootFor(id), client));
register('git_file_diff', '读取文件差异', { ...repoFields, path: z.string().min(1), staged: z.boolean() }, true,
  async ({ id, path, staged }) => ({ patch: await diff(rootFor(id), path, staged) }));
const pathsField = z.array(z.string().min(1)).min(1).max(500);
register('git_changelist_action', '整理本仓库更改分组和新文件偏好', { ...revisionFields, op: z.enum(['create', 'rename', 'remove', 'set-active', 'move', 'policy']), groupId: z.string().optional(), name: z.string().max(120).optional(), paths: pathsField.optional(), newFilePolicy: z.enum(['manual', 'ask', 'auto']).optional() }, false, args => action('changelist', args));
register('git_commit_selected', '仅提交本次勾选文件，保留其他文件和暂存内容', { ...revisionFields, paths: pathsField, message: z.string().trim().min(1).max(65536) }, false, args => action('commit-selected', args));
register('git_generate_selected_message', 'AI 分析本次勾选文件并生成提交信息', { ...revisionFields, paths: pathsField }, true, args => action('generate-selected', args), { openWorldHint: true });
register('git_list_shelves', '读取已保存的搁置列表', repoFields, true, async ({ id }) => ({ shelves: await listShelves(rootFor(id)) }));
register('git_shelf_diff', '预览搁置文件的差异', { ...repoFields, shelfId: z.string(), path: z.string().min(1) }, true, ({ id, shelfId, path }) => shelfDiff(rootFor(id), shelfId, path));
register('git_create_shelf', '保存所选文件的改动并从当前工作区撤下', { ...revisionFields, paths: pathsField, name: z.string().min(1).max(120), groupId: z.string().optional() }, false, args => action('shelf-create', args));
register('git_restore_shelf', '恢复所选搁置文件，冲突时核对合并结果', { ...revisionFields, shelfId: z.string(), paths: pathsField.optional(), groupId: z.string().optional(), resolutions: z.array(z.object({ path: z.string(), token: z.string(), content: z.string().optional(), choice: z.enum(['current', 'shelf']).optional() })).optional() }, false, args => action('shelf-restore', args));
register('git_stage_file', '暂存指定文件', fileFields, false, args => action('stage', args));
register('git_unstage_file', '取消暂存指定文件并保留修改', fileFields, false, args => action('unstage', args));
register('git_set_files_staged', '批量暂存或移出选定文件并保留工作区内容', { ...revisionFields, paths: z.array(z.string().min(1)).min(1).max(500), staged: z.boolean() }, false, args => action('set-staging', args));
register('git_stage_hunk', '暂存或取消暂存指定代码块', { ...fileFields, staged: z.boolean(), hunk: z.number().int().min(0) }, false,
  args => action('hunk', args));
register('git_generate_message', '根据已暂存内容生成提交说明', revisionFields, true, args => action('generate', args), { openWorldHint: true });
register('git_commit_staged', '提交已暂存内容', { ...revisionFields, message: z.string().trim().min(1).max(65536) }, false,
  args => action('commit', args));
const syncFields = { ...revisionFields, previewToken: z.string().regex(/^[a-f0-9]{48}$/) };
register('git_sync_targets', '读取当前分支的远程目标', repoFields, true, ({ id }) => syncTargets(rootFor(id)));
register('git_check_push', '获取远程并预览待更新和待推送提交', { ...revisionFields, remote: z.string().min(1).max(1024), branch: z.string().min(1).max(1024), strategy: z.enum(['merge', 'rebase']), setUpstream: z.boolean() }, false, args => action('sync-check', args), { openWorldHint: true });
register('git_update_remote', '按确认的远程预览更新本地分支', syncFields, false, args => action('sync-update', args), { openWorldHint: true });
register('git_push_branch', '按确认的预览先更新再推送当前分支', syncFields, false, args => action('push', args), { openWorldHint: true });
register('git_branch_list', '读取本地和远程分支列表', repoFields, true, async ({ id }) => branchList(rootFor(id)));
register('git_merge_preview', '预览合并方向和传入提交', branchFields, true, async args => mergePreview(rootFor(args.id), args));
register('git_switch_branch', '切换到选定分支并保留允许携带的本地改动', branchFields, false, args => action('switch', args));
register('git_merge_branch', '将选定分支合并到当前分支', branchFields, false, args => action('merge', args));
register('git_continue_merge', '提交已解决并暂存的合并结果', revisionFields, false, args => action('merge-continue', args));
register('git_abort_merge', '中止进行中的合并并放弃本次冲突解决修改', revisionFields, false, args => action('merge-abort', args), { destructiveHint: true });
register('git_resolve_conflict_file', '将用户确认已解决的冲突文件加入暂存区', fileFields, false, args => action('resolve', args));
register('git_conflict_versions', '读取冲突的共同基础、两边版本和自动合并草稿', fileFields, true, args => conflictPreview(rootFor(args.id), args.path, args.revision));
const conflictFields = { ...fileFields, token: z.string().regex(/^[a-f0-9]{64}$/) };
register('git_suggest_conflict_merge', 'AI 分析三方修改意图并生成可编辑冲突块建议', conflictFields, true, args => mutate(rootFor(args.id), 'conflict-ai', args), { openWorldHint: true });
register('git_apply_conflict_merge', '应用用户核对的合并结果并暂存此文件，原内容先备份', { ...conflictFields, content: z.string().max(180000), deleted: z.boolean() }, false, args => action('conflict-apply', args));

register('git_continue_rebase', '继续已解决冲突的变基', revisionFields, false, args => action('rebase-continue', args));
register('git_abort_rebase', '中止进行中的变基', revisionFields, false, args => action('rebase-abort', args), { destructiveHint: true });

register('git_retry_local_restore', '恢复中断前自动保存的本地改动', revisionFields, false, args => action('restore-retry', args));
register('git_finish_local_restore', '核对恢复结果后保留工作区文件并取消暂存，原备份保留', revisionFields, false, args => action('restore-finish', args));

await server.connect(new StdioServerTransport());
