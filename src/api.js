import { App } from '@modelcontextprotocol/ext-apps';
export const isMcp = window.__GIT_PANEL_MCP__ === true;
let token, bridge, connected;
async function call(name, args = {}) {
  await connected;
  const result = await bridge.callServerTool({ name, arguments: args }, { timeout: 300000 });
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || 'Git 操作失败');
  if (!result.structuredContent) throw new Error('Git 服务返回格式不正确');
  return result.structuredContent;
}
export async function initialize() {
  if (isMcp) {
    bridge = new App({ name: 'Git 提交', version: '0.10.0' }, {}, { autoResize: false });
    connected = bridge.connect(undefined, { timeout: 15000 });
    return call('git_panel_session');
  }
  const r = await fetch('/api/session');
  if (!r.ok) throw new Error('无法连接本地 Git 服务');
  const data = await r.json(); token = data.token; return data;
}
export async function request(route, data) {
  if (isMcp) {
    const url = new URL(route, 'https://git-panel.invalid');
    const id = url.searchParams.get('id');
    if (url.pathname === '/api/open') return call('git_open_repository', data);
    if (url.pathname === '/api/shelves') return call('git_list_shelves', { id });
    if (url.pathname === '/api/shelf-diff') return call('git_shelf_diff', { id, ...data });
    if (url.pathname === '/api/file') return call('git_read_editable_file', { id, ...data });
    if (url.pathname === '/api/watch') return call('git_wait_changes', { id, ...data });
    if (url.pathname === '/api/watch-stop') return call('git_stop_watching', { id, ...data });
    if (url.pathname === '/api/state') return call('git_repository_state', { id });
    if (url.pathname === '/api/sync-targets') return call('git_sync_targets', { id });
    if (url.pathname === '/api/branches') return call('git_branch_list', { id });
    if (url.pathname === '/api/merge-preview') return call('git_merge_preview', { id, ...data });
    if (url.pathname === '/api/conflict') return call('git_conflict_versions', { id, ...data });
    if (url.pathname === '/api/diff') return call('git_file_diff', { id, path: url.searchParams.get('path'), staged: url.searchParams.get('staged') === 'true' });
    if (url.pathname === '/api/action') {
      if (['conflict-ai', 'conflict-apply'].includes(data.action)) { const { action, ...args } = data; return call(action === 'conflict-ai' ? 'git_suggest_conflict_merge' : 'git_apply_conflict_merge', { id, ...args }); }
      if (data.action === 'set-staging') { const { action, ...args } = data; return call('git_set_files_staged', { id, ...args }); }
      const names = { changelist: 'git_changelist_action', 'commit-selected': 'git_commit_selected', 'generate-selected': 'git_generate_selected_message', 'shelf-create': 'git_create_shelf', 'shelf-restore': 'git_restore_shelf', 'file-save': 'git_save_file', exclusions: 'git_set_exclusions', 'restore-retry': 'git_retry_local_restore', 'restore-finish': 'git_finish_local_restore', 'sync-check': 'git_check_push', 'sync-update': 'git_update_remote', 'rebase-continue': 'git_continue_rebase', 'rebase-abort': 'git_abort_rebase', stage: 'git_stage_file', unstage: 'git_unstage_file', hunk: 'git_stage_hunk', generate: 'git_generate_message', commit: 'git_commit_staged', push: 'git_push_branch', switch: 'git_switch_branch', merge: 'git_merge_branch', 'merge-continue': 'git_continue_merge', 'merge-abort': 'git_abort_merge', resolve: 'git_resolve_conflict_file' };
      const { action, ...args } = data;
      if (!names[action]) throw new Error('不支持的操作');
      return call(names[action], { id, ...args });
    }
    throw new Error('未知接口');
  }
  const r = await fetch(route, { method: data ? 'POST' : 'GET', headers: { 'x-git-panel-token': token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || '操作失败');
  return result;
}
