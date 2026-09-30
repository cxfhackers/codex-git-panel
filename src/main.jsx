import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GitBranch, RefreshCw, Search, FolderOpen, Sparkles, AlertCircle, Check, ArrowUp, ArrowDown, ChevronDown } from 'lucide-react';
import Diff from './Diff';
import Dropdown from './Dropdown';
import SyncDialog from './SyncDialog';
import BranchDialog, { MergeDialog, RecoveryDialog } from './BranchDialog';
import { initialize, request, isMcp } from './api';
import { storage } from './storage';
import Dialog from './Dialog';
import ConflictDialog from './ConflictDialog';
import { createStagingQueue, previewStaging } from './staging';
import { selectPath } from './selection';
import './style.css';
const labels = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变更', '?': '新增 · 未跟踪', U: '冲突' };
function App() {
  const [projects, setProjects] = useState([]), [id, setId] = useState(''), [state, setState] = useState(null);
  const [tab, setTab] = useState('work'), [filter, setFilter] = useState(''), [path, setPath] = useState(''), [patch, setPatch] = useState('');
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [message, setMessage] = useState(''), [generated, setGenerated] = useState(''), [custom, setCustom] = useState('');
  const [dialog, setDialog] = useState(''), [push, setPush] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false), [pendingStaging, setPendingStaging] = useState([]);
  const [branchOpen, setBranchOpen] = useState(false), [mergeConfirm, setMergeConfirm] = useState('');
  const [resolvePath, setResolvePath] = useState('');
  const [project, setProject] = useState(null), [syncMode, setSyncMode] = useState(''), [syncInfo, setSyncInfo] = useState(null);
  const projectKey = useRef(''), branchTrigger = useRef(null), selectionAnchor = useRef(null);
  const diffSerial = useRef(0), patchCache = useRef(new Map()), stagingQueue = useRef(null), pending = useRef(false), context = useRef({ id: '', state: null, message: '', generated: '' });
  if (!stagingQueue.current) stagingQueue.current = createStagingQueue({
    getContext: () => context.current,
    send: (repoId, args) => request(`/api/action?id=${repoId}`, args),
    read: repoId => request(`/api/state?id=${repoId}`),
    onState: acceptState, onPending: setPendingStaging, onError: setError,
  });
  const locked = busy || pendingStaging.length > 0;
  const displayFiles = previewStaging(state?.files || [], pendingStaging);
  const staged = tab === 'staged', file = displayFiles.find(f => f.path === path);
  const previewStaged = file ? staged ? file.staged || !file.unstaged : !file.unstaged && file.staged : staged;
  const stagedFiles = displayFiles.filter(f => f.staged);
  const tabFiles = displayFiles.filter(f => staged ? f.staged : f.unstaged);
  const files = tabFiles.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
  const selectablePaths = files.filter(f => !f.conflict).map(f => f.path);
  const selectedFiles = tabFiles.filter(f => !f.conflict && selectedPaths.has(f.path));
  const hiddenSelectionCount = selectedFiles.filter(f => !files.some(visible => visible.path === f.path)).length;
  const conflicts = state?.files.filter(f => f.conflict) || [];
  useEffect(() => { (async () => { try { const data = await initialize(); setProjects(data.projects); setProject(data.project); projectKey.current = data.project?.key || 'default'; const last = storage.get('git-panel-root:' + projectKey.current); const selected = data.projects.find(p => p.root === last)?.root || data.project?.defaultRoot; if (selected) await openRepo(selected); } catch (e) { setError(e.message); } })(); }, []);
  useEffect(() => {
    const serial = ++diffSerial.current;
    if (!id || !path || !file) { setPatch(''); setDiffLoading(false); return; }
    if (file.pending) { setDiffLoading(true); return; }
    const key = JSON.stringify([id, path, previewStaged, state.revision]);
    if (patchCache.current.has(key)) { setPatch(patchCache.current.get(key)); setDiffLoading(false); return; }
    setPatch(''); setDiffLoading(true);
    (async () => {
      try {
        const data = await request(`/api/diff?id=${id}&path=${encodeURIComponent(path)}&staged=${previewStaged}`);
        if (serial === diffSerial.current) {
          patchCache.current.set(key, data.patch);
          if (patchCache.current.size > 16) patchCache.current.delete(patchCache.current.keys().next().value);
          setPatch(data.patch);
        }
      } catch (e) { if (serial === diffSerial.current) setError(e.message); }
      finally { if (serial === diffSerial.current) setDiffLoading(false); }
    })();
  }, [id, path, previewStaged, state?.revision, !!file?.pending]);
  function acceptState(next) { context.current.state = next; setState(next); }
  async function runTask(task) {
    if (pending.current || stagingQueue.current.size) return null;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { return await task(); } catch (e) { setError(e.message); return null; }
    finally { pending.current = false; setBusy(false); }
  }
  function draftKey(root) { return 'git-panel-draft:' + projectKey.current + ':' + root; }
  function setDraft(value, revision = context.current.generated || '') {
    context.current.message = value; context.current.generated = revision; setMessage(value); setGenerated(revision);
    if (context.current.state) storage.set(draftKey(context.current.state.root), JSON.stringify({ message: value, generated: revision }));
  }
  async function openRepo(root) {
    return runTask(async () => {
      const data = await request('/api/open', { root: root.trim() });
      ++diffSerial.current;
      context.current.id = data.id; setId(data.id); acceptState(data.state);
      setProjects(current => current.some(p => p.root === data.state.root) ? current : [...current, { label: data.state.root.split('/').at(-1), root: data.state.root }]);
      setTab('work'); clearSelection(); setFilter(''); setPath(''); setPatch(''); setDiffLoading(false); let draft = {}; try { draft = JSON.parse(storage.get(draftKey(data.state.root)) || '{}'); } catch {} setDraft(draft.message || '', draft.generated || '');
      setSyncInfo(null); setSyncMode(''); setResolvePath('');
      storage.set('git-panel-root:' + projectKey.current, data.state.root); setCustom(data.state.root); setDialog('');
      setBranchOpen(false); setMergeConfirm('');
    });
  }
  async function refresh() {
    if (!context.current.id) return;
    return runTask(async () => acceptState(await request(`/api/state?id=${context.current.id}`)));
  }
  function disconnect() {
    if (pending.current || stagingQueue.current.size) return;
    context.current = { id: '', state: null, message: '', generated: '' }; storage.remove('git-panel-root:' + projectKey.current); setId(''); setState(null); setTab('work'); clearSelection(); setFilter(''); setPath(''); setPatch(''); setMessage(''); setGenerated(''); setError(''); setNotice(''); setCustom(''); setDialog('');
  }
  async function action(name, extra = {}) {
    return runTask(async () => { const result = await request(`/api/action?id=${context.current.id}`, { action: name, revision: context.current.state.revision, ...extra }); acceptState(result.state); if (result.message) { setDraft(result.message, result.state.revision); setNotice('AI 已分析暂存差异并生成说明，可继续编辑'); } return result; });
  }
  function setFilesStaged(paths, staged) {
    if (pending.current || !context.current.state) return;
    setError(''); setNotice('');
    const requested = new Set(paths);
    const selected = displayFiles.filter(file => requested.has(file.path) && !file.conflict);
    if (selected.length) stagingQueue.current.enqueue(selected, staged);
  }
  function clearSelection() { setSelectedPaths(new Set()); selectionAnchor.current = null; }
  function changeTab(next) { if (next !== tab) { clearSelection(); setPath(''); setFilter(''); setTab(next); } }
  function selectFile(f, event) {
    setPath(f.path);
    if (f.conflict) { if (!locked) setResolvePath(f.path); return; }
    const next = selectPath(selectablePaths, selectedPaths, selectionAnchor.current, f.path, {
      shift: event.shiftKey, additive: event.ctrlKey || event.metaKey,
    });
    selectionAnchor.current = next.anchor;
    setSelectedPaths(next.paths);
  }
  function fileListKeyDown(event) {
    if (!event.target.classList.contains('file-name')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault(); setSelectedPaths(new Set(selectablePaths)); selectionAnchor.current = event.target.dataset.path; return;
    }
    if (event.key === 'Escape') { event.preventDefault(); clearSelection(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const current = selectablePaths.indexOf(event.target.dataset.path);
    const nextPath = selectablePaths[current + (event.key === 'ArrowDown' ? 1 : -1)];
    const nextFile = files.find(f => f.path === nextPath);
    if (!nextFile) return;
    selectFile(nextFile, event);
    [...event.currentTarget.querySelectorAll('.file-name')].find(button => button.dataset.path === nextPath)?.focus();
  }
  async function branchAction(name, args) {
    return runTask(async () => {
      try {
        const result = await request(`/api/action?id=${context.current.id}`, { action: name, ...args });
        ++diffSerial.current; acceptState(result.state); clearSelection(); setTab(['resolve', 'conflict-apply'].includes(name) ? 'staged' : 'work'); setFilter(''); setPath(['resolve', 'conflict-apply'].includes(name) ? args.path : ''); setPatch(''); setDiffLoading(false); setSyncInfo(null);
        if (result.state.files.some(f => f.conflict) && ['merge', 'merge-continue', 'rebase-continue'].includes(name)) { setBranchOpen(false); setMergeConfirm(''); setResolvePath(result.state.files.find(f => f.conflict).path); }
        if (result.warning) setError(`${result.warning}\n${result.output || ''}`); else setNotice(result.output || 'Git 操作已完成');
        return result;
      } catch (e) { setError(e.message); return { status: 'error', error: e.message }; }
    });
  }
  async function commit() {
    if (pending.current || stagingQueue.current.size) return; setDialog('');
    return runTask(async () => {
      const result = await request(`/api/action?id=${context.current.id}`, { action: 'commit', revision: context.current.state.revision, message }); acceptState(result.state);
      setDraft('', ''); setNotice(push ? '本地提交已成功，请核对推送预览。' : '本地提交已成功，尚未推送。');
      setSyncInfo(null); if (push) setSyncMode('push');
      return result;
    });
  }
  async function syncAction(name, args) {
    return runTask(async () => {
      try {
        const result = await request(`/api/action?id=${context.current.id}`, { action: name, ...args });
        if (result.state) { const moved = context.current.state.head !== result.state.head; acceptState(result.state); if (moved) { ++diffSerial.current; clearSelection(); setPath(''); setPatch(''); } }
        if (result.previewToken) setSyncInfo(result);
        else if (result.status === 'success') { setSyncInfo(null); setNotice(result.output); if (result.warning) setError(result.warning); }
        else if (result.status === 'conflict' || result.status === 'merge-pending' || result.status === 'restore-conflict') { setSyncInfo(null); setError(result.warning); const conflict = result.state?.files.find(f => f.conflict); if (conflict) { setSyncMode(''); setResolvePath(conflict.path); } }
        return result;
      } catch (e) { return { status: 'error', error: e.message }; }
    });
  }
  const freshSync = syncInfo?.state.head === state?.head && syncInfo?.state.headRef === state?.headRef ? syncInfo : null;
  const counts = freshSync || state?.sync;
  const changed = generated && generated !== state?.revision;
  return <main className="app">
    <header className="toolbar"><h1><GitBranch size={23}/>Git</h1><div className="repository-picker"><label htmlFor="active-repository">仓库</label><Dropdown id="active-repository" label="切换 Git 仓库" title={state?.root || '选择 Git 仓库'} value={state?.root || ''} options={projects.map(p => ({ value: p.root, label: p.label }))} disabled={locked} onChange={openRepo} placeholder="选择仓库…" className="repository-dropdown"/></div><button className="repo-button" aria-label="当前项目仓库" title="当前项目仓库 / worktree" disabled={locked} onClick={() => { setCustom(state?.root || ''); setDialog('repo'); }}><FolderOpen size={15}/></button>{state && <button ref={branchTrigger} className="branch" aria-label="分支管理" aria-haspopup="dialog" aria-expanded={branchOpen} title="切换或合并分支" disabled={locked} onClick={() => setBranchOpen(true)}><GitBranch size={14}/><span className="branch-name">{state.branch}</span><ChevronDown size={13}/></button>}{state && <div className="sync-controls"><button aria-label="更新" title="检查远程并更新当前分支" disabled={locked || !state.headRef || !!state.operation} onClick={() => setSyncMode('update')}><ArrowDown size={14}/><span className="action-label">更新</span></button><button aria-label="推送" title={`检查远程并推送${counts ? ` · ${counts.ahead} 个待推送提交` : ''}`} className="push-button" disabled={locked || !state.headRef || !!state.operation || !state.head} onClick={() => setSyncMode('push')}><ArrowUp size={14}/><span className="action-label">推送</span></button>{counts && <div className="sync-status" aria-label="同步状态" title={`${freshSync?.target.name || state.upstream || '未设置上游'} · ${counts.ahead} 待推送 · ${counts.behind} 待更新 · ${freshSync ? '已检查远程' : '本机记录'}`}><span className="outgoing">↑ {counts.ahead}<span className="count-label"> 待推送</span></span><span className="incoming">↓ {counts.behind}<span className="count-label"> 待更新</span></span><small className="sync-source">{freshSync ? '已检查远程' : '本机记录'}</small></div>}</div>}<button className="refresh" aria-label="刷新" disabled={!state || locked} onClick={refresh}><RefreshCw size={16} className={busy ? 'spinning' : ''}/><span>刷新</span></button></header>
    <div className="repo-path" title={state?.root}>{project?.label ? `${project.label} · ` : ''}{state?.root || '当前目录未找到 Git 仓库，请选择项目仓库'}</div>
    {state?.operation && <section className="operation-banner" aria-label="Git 操作状态"><div><strong>{state.operation.type === 'local-restore' ? '本地改动待恢复 · 原始备份已保留' : ['merge', 'rebase'].includes(state.operation.type) ? conflicts.length ? `${state.operation.type === 'rebase' ? '变基' : '合并'}进行中 · ${conflicts.length} 个冲突文件` : `${state.operation.type === 'rebase' ? '变基' : '合并'}待完成` : `Git 操作未完成：${state.operation.type}`}</strong><p>{state.operation.type === 'local-restore' ? '先核对恢复结果。打开冲突文件进行三方合并并标记已解决，再完成恢复；不需要提交本地文件。原始内容可在 Git stash 中查看。' : ['merge', 'rebase'].includes(state.operation.type) ? conflicts.length ? '点击冲突文件使用智能合并，核对结果并暂存后继续；也可中止当前操作。' : '核对暂存内容后继续当前操作。' : '请在原 IDE 或终端完成当前操作，再刷新面板。'}</p>{state.operation.localBackup && state.operation.type !== 'local-restore' && <p>本地改动已自动保存，完成或中止后将恢复。</p>}</div>{state.operation.type === 'local-restore' ? <div className="operation-actions">{['saved', 'preparing'].includes(state.operation.localBackup.phase) && <button disabled={locked || !!state.files.length} onClick={() => setMergeConfirm('restore-retry')}>重试恢复</button>}<button disabled={locked || !!conflicts.length} onClick={() => setMergeConfirm('restore-finish')}>完成恢复</button></div> : ['merge', 'rebase'].includes(state.operation.type) && <div className="operation-actions"><button disabled={locked || !!conflicts.length || state.operation.type === 'rebase' && state.files.some(f => f.unstaged)} onClick={() => setMergeConfirm(state.operation.type + '-continue')}>继续{state.operation.type === 'rebase' ? '变基' : '合并'}</button><button disabled={locked} onClick={() => setMergeConfirm(state.operation.type + '-abort')}>中止{state.operation.type === 'rebase' ? '变基' : '合并'}</button></div>}</section>}
    {(error || notice) && <div role={error ? 'alert' : 'status'} className={`notification ${error ? 'error' : 'success'}`}>{error ? <AlertCircle size={16}/> : <Check size={16}/>}<span>{error || notice}</span><button aria-label="关闭通知" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    <div className="workspace">
      <aside className="file-pane">
        <nav aria-label="改动范围">
          <button aria-current={!staged ? 'page' : undefined} className={!staged ? 'active' : ''} onClick={() => changeTab('work')}>工作区 <span>{displayFiles.filter(f => f.unstaged).length}</span></button>
          <button aria-current={staged ? 'page' : undefined} className={staged ? 'active' : ''} onClick={() => changeTab('staged')}>已暂存 <span>{stagedFiles.length}</span></button>
        </nav>
        <label className="search" htmlFor="file-search"><Search size={16}/><input id="file-search" aria-label="筛选文件" placeholder="筛选文件" value={filter} onChange={e => setFilter(e.target.value)}/></label>
        <div className="list-label">
          <span>{staged ? '提交范围' : '更改'} · {files.length}</span>
          {!selectedFiles.length && <button className="list-batch" disabled={busy || !selectablePaths.length} onClick={() => setFilesStaged(selectablePaths, !staged)}>{staged ? '全部移出' : filter ? '暂存筛选结果' : '全部暂存'}</button>}
        </div>
        {selectedFiles.length > 0 && <div className="selection-bar" role="status">
          <span title="点击文件行选择；Shift 连选；Ctrl 或 ⌘ 加选">已选 {selectedFiles.length}{hiddenSelectionCount > 0 ? ` · ${hiddenSelectionCount} 个被筛选隐藏` : ''}</span>
          <button className="selection-clear" onClick={clearSelection}>清除</button>
          <button className="selection-apply" disabled={busy} onClick={() => { setFilesStaged(selectedFiles.map(f => f.path), !staged); clearSelection(); }}>{staged ? '移出所选' : '暂存所选'}</button>
        </div>}
        {!!pendingStaging.length && <div className="staging-progress" role="status"><RefreshCw size={12} className="spinning"/>正在同步 {pendingStaging.length} 个文件的暂存状态…</div>}
        <div className="file-list" aria-label={staged ? '已暂存文件' : '工作区文件'} onKeyDown={fileListKeyDown}>
          {files.map(f => {
            const kind = f.conflict ? 'U' : f.code === '??' ? '?' : f.code[staged ? 0 : 1];
            return <div className={`file-row ${selectedPaths.has(f.path) && !f.conflict ? 'selected' : ''} ${path === f.path ? 'preview' : ''} ${f.pending ? 'pending' : ''}`} key={f.path} onClick={e => { if (!e.target.closest('input,.resolve-button')) selectFile(f, e); }} onContextMenu={e => { if (e.ctrlKey && !f.conflict) { e.preventDefault(); selectFile(f, e); } }}>
              {!f.conflict && <input type="checkbox" aria-label={`${staged ? '取消暂存' : '暂存'} ${f.path}`} checked={staged} disabled={busy} onClick={e => e.stopPropagation()} onChange={() => { setFilesStaged([f.path], !staged); setSelectedPaths(previous => { const next = new Set(previous); next.delete(f.path); return next; }); if (selectionAnchor.current === f.path) selectionAnchor.current = null; }}/>}
              <button className="file-name" data-path={f.path} aria-pressed={!f.conflict ? selectedPaths.has(f.path) : undefined} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}><span>{f.path.split('/').at(-1)}</span><small>{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '仓库根目录'}</small></button>
              {f.conflict && <button className="resolve-button" aria-label={`解决冲突 ${f.path}`} disabled={locked} onClick={e => { e.stopPropagation(); setResolvePath(f.path); }}>解决冲突</button>}
              <span className={`status status-${kind.replace('?', 'new')}`} title={labels[kind] || kind}>{kind === '?' ? 'A' : kind}</span>
            </div>;
          })}
          {!files.length && <div className="list-empty">{!state ? '尚未选择仓库' : filter ? '没有匹配的文件' : staged ? '没有已暂存的文件' : '工作区没有待暂存的改动'}</div>}
        </div>
        <div className="legend"><span className="status-M">M 修改</span><span className="status-A">A 新增</span><span className="status-D">D 删除</span></div>
      </aside>
      <Diff path={file ? path : ''} patch={patch} loading={diffLoading} file={file} staged={previewStaged} busy={locked || diffLoading} onHunk={hunk => action('hunk', { path, staged: previewStaged, hunk })}/>
    </div>
    <section className="commit-panel"><div className="commit-heading"><label htmlFor="message">提交信息</label><button disabled={locked || !!state?.operation || !stagedFiles.length} onClick={() => action('generate')} title="使用本机已登录的 Codex 分析暂存差异，生成可编辑说明"><Sparkles size={15}/>{busy ? '处理中…' : 'AI 生成'}</button></div><textarea disabled={busy} id="message" placeholder="描述本次修改…" value={message} onChange={e => setDraft(e.target.value)} spellCheck={false}/>{changed && <div className="message-warning">仓库内容已变化，请核对或重新生成提交说明。</div>}<div className="commit-actions"><span><Check size={15}/>只提交已暂存的内容</span><div><button className="primary" disabled={locked || !!state?.operation || !!conflicts.length || !message.trim() || !stagedFiles.length} onClick={() => { setPush(false); setDialog('commit'); }}>提交</button><button disabled={locked || !!state?.operation || !!conflicts.length || !message.trim() || !stagedFiles.length} title="提交成功后核对推送目标与待推送提交" onClick={() => { setPush(true); setDialog('commit'); }}><ArrowUp size={15}/>提交并推送</button></div></div></section>
    <footer>{state ? `${state.files.length} 个更改文件 · ${stagedFiles.length} 个已暂存` : isMcp ? 'MCP · 本机 Git' : '本地 Git 工具'}<span>{state?.upstream || (state ? '未设置上游' : '代码保留在本机')}</span></footer>
    {syncMode && <SyncDialog key={id + syncMode} id={id} mode={syncMode} state={state} onExecute={syncAction} onClose={() => setSyncMode('')}/>}
    {branchOpen && <BranchDialog anchor={branchTrigger.current?.getBoundingClientRect()} key={id} id={id} busy={locked} onState={acceptState} onExecute={branchAction} onClose={() => setBranchOpen(false)}/>}
    {mergeConfirm && (mergeConfirm.startsWith('restore-') ? <RecoveryDialog state={state} mode={mergeConfirm} busy={locked} onExecute={branchAction} onClose={() => setMergeConfirm('')}/> : <MergeDialog state={state} mode={mergeConfirm} busy={locked} onExecute={branchAction} onClose={() => setMergeConfirm('')}/>)}
    {resolvePath && <ConflictDialog key={id + resolvePath} id={id} state={state} onState={acceptState} onNext={setResolvePath} path={resolvePath} busy={locked} onExecute={branchAction} onClose={() => setResolvePath('')}/>}
    {dialog && <Dialog key={dialog} busy={locked} onClose={() => setDialog('')} aria-labelledby="main-dialog-title"><h2 id="main-dialog-title">{dialog === 'repo' ? '选择 Git 仓库' : push ? '确认提交并推送' : '确认提交'}</h2>{dialog === 'repo' ? <><div className="project-list">{projects.map(p => <button key={p.root} disabled={locked} onClick={() => openRepo(p.root)}><FolderOpen size={17}/><div><strong>{p.label}</strong><small>{p.root}</small></div></button>)}</div><form onSubmit={e => { e.preventDefault(); openRepo(custom); }}><label htmlFor="repo-root">当前项目仓库 / worktree 的绝对路径</label><input id="repo-root" placeholder="/Users/…/项目目录" data-dialog-autofocus value={custom} onChange={e => setCustom(e.target.value)} required autoFocus onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (custom.trim()) openRepo(custom); } }}/>{error && <p className="form-error">{error}</p>}<div className="dialog-actions">{state && <button type="button" onClick={disconnect}>关闭当前仓库</button>}<button type="button" onClick={() => setDialog('')}>取消</button><button className="primary" disabled={locked || !custom.trim()} type="button" onClick={() => openRepo(custom)}>打开仓库</button></div></form></> : <><p className="confirm-branch">{state.root} · {state.branch}</p><p>本次包含以下 {stagedFiles.length} 个已暂存文件：</p><ul className="confirm-files">{stagedFiles.map(f => <li key={f.path}>{f.path}</li>)}</ul><pre className="confirm-message">{message}</pre>{changed && <p className="message-warning">说明生成后仓库已变化，请先重新核对。</p>}<div className="dialog-actions"><button onClick={() => setDialog('')}>返回检查</button><button className="primary" disabled={locked} onClick={commit}>确认{push ? '提交并推送' : '提交'}</button></div></>}</Dialog>}
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
