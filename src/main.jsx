import InlineEditor from './InlineEditor';
import ChangeTree from './ChangeTree';
import Shelves from './Shelves';
import { commitPaths } from './changes';
import ExclusionDialog from './ExclusionDialog';
import { useRepositoryWatch } from './useRepositoryWatch';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GitBranch, RefreshCw, FolderOpen, Sparkles, AlertCircle, Check, ArrowUp, ArrowDown, ChevronDown } from 'lucide-react';
import Dropdown from './Dropdown';
import SyncDialog from './SyncDialog';
import BranchDialog, { MergeDialog, RecoveryDialog } from './BranchDialog';
import { initialize, request, isMcp } from './api';
import { storage } from './storage';
import Dialog from './Dialog';
import ConflictDialog from './ConflictDialog';


import './style.css';
function App() {
  const [projects, setProjects] = useState([]), [id, setId] = useState(''), [state, setState] = useState(null);
  const [tab, setTab] = useState('work'), [path, setPath] = useState(''), [patch, setPatch] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [included, setIncluded] = useState(new Set()), [dirtyPaths, setDirtyPaths] = useState([]);
  const [shelfForm, setShelfForm] = useState(null), [shelfName, setShelfName] = useState('');
  const autoAttempt = useRef('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [message, setMessage] = useState(''), [generated, setGenerated] = useState(''), [custom, setCustom] = useState('');
  const [dialog, setDialog] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false), [mergeConfirm, setMergeConfirm] = useState('');
  const [resolvePath, setResolvePath] = useState('');
  const [project, setProject] = useState(null), [syncMode, setSyncMode] = useState(''), [syncInfo, setSyncInfo] = useState(null), [updating, setUpdating] = useState(false);
  const projectKey = useRef(''), branchTrigger = useRef(null);
  const diffSerial = useRef(0), patchCache = useRef(new Map()), stagingQueue = useRef(null), pending = useRef(false), context = useRef({ id: '', state: null, message: '', generated: '' });
  if (!stagingQueue.current) stagingQueue.current = { size: 0 };
  const watcher = useRepositoryWatch(id, context, pending, stagingQueue, acceptState);
  const locked = busy;
  const displayFiles = state?.files || [];
  const file = displayFiles.find(f => f.path === path);
  const previewStaged = file?.staged && !file?.unstaged;
  const chosenPaths = commitPaths(displayFiles, included);
  const changedDrafts = chosenPaths.some(path => dirtyPaths.includes(path));
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
  function acceptState(next) { if (!next) return; context.current.state = next; setState(next); setIncluded(previous => new Set(commitPaths(next.files, previous))); }
  async function runTask(task) {
    if (pending.current || stagingQueue.current.size) return null;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { return await task(); } catch (e) {
      let text = e.message;
      if (context.current.id && /已变化|重新核对/.test(text)) {
        try { acceptState(await request(`/api/state?id=${context.current.id}`)); text = text.replace(/请刷新后|请刷新/g, '请') + '（已自动同步最新状态）'; } catch {}
      }
      setError(text); return null;
    }
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
      setTab('work'); setIncluded(new Set()); setPath(''); setPatch(''); setDiffLoading(false); let draft = {}; try { draft = JSON.parse(storage.get(draftKey(data.state.root)) || '{}'); } catch {} setDraft(draft.message || '', draft.generated || '');
      setSyncInfo(null); setSyncMode(''); setResolvePath(''); setRulesOpen(false);
      storage.set('git-panel-root:' + projectKey.current, data.state.root); setCustom(data.state.root); setDialog('');
      setBranchOpen(false); setMergeConfirm('');
    });
  }
  function disconnect() {
    if (pending.current || stagingQueue.current.size) return;
    context.current = { id: '', state: null, message: '', generated: '' }; storage.remove('git-panel-root:' + projectKey.current); setId(''); setState(null); setTab('work'); setIncluded(new Set()); setPath(''); setPatch(''); setMessage(''); setGenerated(''); setError(''); setNotice(''); setCustom(''); setDialog('');
  }
  async function action(name, extra = {}) {
    return runTask(async () => { const result = await request(`/api/action?id=${context.current.id}`, { action: name, revision: context.current.state.revision, ...extra }); acceptState(result.state); if (result.message) { setDraft(result.message, result.state.revision + ':' + JSON.stringify([...extra.paths].sort())); setNotice('AI 已分析勾选文件并生成说明，可继续编辑'); } else if (result.output) setNotice(result.output); if (result.warning) setError(result.warning); return result; });
  }
  function onInclude(paths, checked) {
    setIncluded(previous => { const next = new Set(previous); for (const p of paths) checked ? next.add(p) : next.delete(p); return next; });
  }
  async function changeRules(rules) {
    const result = await action('exclusions', { rules });
    if (result) setNotice('永不提交规则已保存；本地文件内容保留');
    return result;
  }
  async function moveFiles(groupId, paths) {
    if (groupId === 'excluded') {
      const files = state.files.filter(f => paths.includes(f.path));
      return changeRules([...(state.exclusions || []), ...files.flatMap(f => [f.path, ...(f.oldPath ? [f.oldPath] : [])].map(path => ({ type: 'file', path })))]);
    }
    return runTask(async () => {
      let before = context.current.state;
      const selected = before.files.filter(f => paths.includes(f.path));
      if (selected.some(f => f.excluded)) {
        const all = new Set(selected.flatMap(f => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
        const rules = before.exclusions.filter(r => r.type !== 'file' || !all.has(r.path));
        for (const p of all) if (rules.some(r => r.type === 'directory' && (p === r.path || p.startsWith(r.path + '/')))) rules.push({ type: 'file', path: p, excluded: false });
        const result = await request(`/api/action?id=${id}`, { action: 'exclusions', revision: before.revision, rules }); acceptState(result.state); before = result.state;
      }
      const untracked = before.files.filter(f => paths.includes(f.path) && f.code === '??').map(f => f.path);
      if (untracked.length) { const result = await request(`/api/action?id=${id}`, { action: 'set-staging', revision: before.revision, paths: untracked, staged: true }); acceptState(result.state); before = result.state; }
      const result = await request(`/api/action?id=${id}`, { action: 'changelist', revision: before.revision, op: 'move', groupId, paths }); acceptState(result.state); return result;
    });
  }
  function requestShelf(paths, groupId) {
    if (paths.some(p => dirtyPaths.includes(p))) { setError('这些文件有尚未保存的编辑，请先在右侧保存再搁置'); return; }
    setShelfForm({ paths, groupId: groupId || state.changelists.activeId }); setShelfName('未完成的更改');
  }
  async function createShelf() {
    const result = await action('shelf-create', { ...shelfForm, name: shelfName });
    if (result) { setShelfForm(null); setTab('shelf'); setPath(''); setNotice(result.output || '所选改动已搁置，可在搁置列表恢复'); }
  }
  async function addFiles(paths) { return action('set-staging', { paths, staged: true }); }
  useEffect(() => {
    if (!state || state.changelists?.newFilePolicy !== 'auto' || locked || state.operation) return;
    const paths = state.files.filter(f => f.code === '??' && !f.excluded).map(f => f.path).slice(0, 500);
    if (!paths.length) return;
    const key = id + ':' + state.revision;
    if (autoAttempt.current === key) return;
    autoAttempt.current = key; addFiles(paths);
  }, [id, state?.revision, locked]);
  async function saveFile(args) {
    return runTask(async () => {
      const result = await request(`/api/action?id=${context.current.id}`, { action: 'file-save', ...args });
      if (result.state) acceptState(result.state); setNotice(result.warning || '文件已保存到工作区'); return result;
    });
  }
  async function branchAction(name, args) {
    return runTask(async () => {
      try {
        const result = await request(`/api/action?id=${context.current.id}`, { action: name, ...args });
        ++diffSerial.current; acceptState(result.state); setIncluded(new Set()); setTab('work'); setPath(['resolve', 'conflict-apply'].includes(name) ? args.path : ''); setPatch(''); setDiffLoading(false); setSyncInfo(null);
        if (result.state.files.some(f => f.conflict) && ['merge', 'merge-continue', 'rebase-continue'].includes(name)) { setBranchOpen(false); setMergeConfirm(''); setResolvePath(result.state.files.find(f => f.conflict).path); }
        if (result.warning) setError(`${result.warning}\n${result.output || ''}`); else setNotice(result.output || 'Git 操作已完成');
        return result;
      } catch (e) { setError(e.message); return { status: 'error', error: e.message }; }
    });
  }
  async function commit(pushAfter = false) {
    if (pending.current || stagingQueue.current.size) return; setDialog('');
    return runTask(async () => {
      const result = await request(`/api/action?id=${context.current.id}`, { action: 'commit-selected', revision: context.current.state.revision, paths: chosenPaths, message }); acceptState(result.state);
      setDraft('', ''); if (result.warning) setError(result.warning); setNotice(pushAfter ? '本地提交已成功，请核对推送预览。' : '勾选文件已提交，尚未推送。');
      setSyncInfo(null); if (pushAfter) setSyncMode('push');
      return result;
    });
  }
  function applySyncResult(result) {
    if (result.state) { const moved = context.current.state.head !== result.state.head; acceptState(result.state); if (moved) { ++diffSerial.current; setIncluded(new Set()); setPath(''); setPatch(''); } }
    if (result.previewToken) setSyncInfo(result);
    else if (result.status === 'success') { setSyncInfo(null); setNotice(result.output); if (result.warning) setError(result.warning); }
    else if (result.status === 'conflict' || result.status === 'merge-pending' || result.status === 'restore-conflict') { setSyncInfo(null); setError(result.warning); const conflict = result.state?.files.find(f => f.conflict); if (conflict) { setSyncMode(''); setResolvePath(conflict.path); } }
    return result;
  }
  async function syncAction(name, args) {
    return runTask(async () => {
      try { return applySyncResult(await request(`/api/action?id=${context.current.id}`, { action: name, ...args })); }
      catch (e) { return { status: 'error', error: e.message }; }
    });
  }
  async function updateCurrentBranch() {
    if (!context.current.id || pending.current || stagingQueue.current.size) return;
    setUpdating(true);
    try {
      await runTask(async () => {
        const repoId = context.current.id, before = context.current.state;
        const target = await request(`/api/sync-targets?id=${repoId}`);
        if (!target.remote || !target.branch) throw new Error('当前分支没有可更新的远程，请先配置 Git remote 或上游分支');
        const strategy = storage.get('git-panel-sync-strategy:' + before.root) === 'rebase' ? 'rebase' : 'merge';
        let preview = applySyncResult(await request(`/api/action?id=${repoId}`, { action: 'sync-check', revision: before.revision, remote: target.remote, branch: target.branch, strategy, setUpstream: target.setUpstream }));
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!preview.remoteExists || preview.behind === 0) { setNotice(preview.remoteExists ? '当前分支已是最新，无需更新' : '远程分支尚不存在，无需更新'); return; }
          const result = applySyncResult(await request(`/api/action?id=${repoId}`, { action: 'sync-update', revision: preview.state.revision, previewToken: preview.previewToken }));
          if (result.status === 'remote-changed') { preview = result; continue; }
          if (['success', 'conflict', 'merge-pending', 'restore-conflict'].includes(result.status)) return;
          throw new Error(result.error || result.warning || result.output || '更新未完成，请重试');
        }
        throw new Error('远程分支持续变化，请稍后再点更新');
      });
    } finally { setUpdating(false); }
  }
  const freshSync = syncInfo?.state.head === state?.head && syncInfo?.state.headRef === state?.headRef ? syncInfo : null;
  const counts = freshSync || state?.sync;
  const changed = generated && generated !== state?.revision + ':' + JSON.stringify([...chosenPaths].sort());
  return <main className="app">
    <header className="toolbar"><h1><GitBranch size={23}/>Git</h1><div className="repository-picker"><label htmlFor="active-repository">仓库</label><Dropdown id="active-repository" label="切换 Git 仓库" title={state?.root || '选择 Git 仓库'} value={state?.root || ''} options={projects.map(p => ({ value: p.root, label: p.label }))} disabled={locked} onChange={openRepo} placeholder="选择仓库…" className="repository-dropdown"/></div><button className="repo-button" aria-label="当前项目仓库" title="当前项目仓库 / worktree" disabled={locked} onClick={() => { setCustom(state?.root || ''); setDialog('repo'); }}><FolderOpen size={15}/></button>{state && <button ref={branchTrigger} className="branch" aria-label="分支管理" aria-haspopup="dialog" aria-expanded={branchOpen} title="切换或合并分支" disabled={locked} onClick={() => setBranchOpen(true)}><GitBranch size={14}/><span className="branch-name">{state.branch}</span><ChevronDown size={13}/></button>}{state && <div className="sync-controls"><button aria-label="更新" title="直接检查远程并更新当前分支" disabled={locked || !state.headRef || !state.head || !!state.operation} onClick={updateCurrentBranch}><ArrowDown size={14}/><span className="action-label">更新</span></button><button aria-label="推送" title={`检查远程并推送${counts ? ` · ${counts.ahead} 个待推送提交` : ''}`} className="push-button" disabled={locked || !state.headRef || !!state.operation || !state.head} onClick={() => setSyncMode('push')}><ArrowUp size={14}/><span className="action-label">推送</span></button>{counts && <div className="sync-status" aria-label="同步状态" title={`${freshSync?.target.name || state.upstream || '未设置上游'} · ${counts.ahead} 待推送 · ${counts.behind} 待更新 · ${freshSync ? '已检查远程' : '本机记录'}`}><span className="outgoing">↑ {counts.ahead}<span className="count-label"> 待推送</span></span><span className="incoming">↓ {counts.behind}<span className="count-label"> 待更新</span></span><small className="sync-source">{freshSync ? '已检查远程' : '本机记录'}</small></div>}</div>}{watcher.failed && <button className="refresh" aria-label="重试自动同步连接" disabled={!state || locked} onClick={watcher.retry}><RefreshCw size={14}/>重试连接</button>}</header>
    {updating && <div className="update-lightbar"><progress aria-label="正在更新当前分支"/><span aria-hidden="true"/></div>}
    <div className="repo-path" title={state?.root}>{project?.label ? `${project.label} · ` : ''}{state?.root || '当前目录未找到 Git 仓库，请选择项目仓库'}</div>
    {state?.operation && <section className="operation-banner" aria-label="Git 操作状态"><div><strong>{state.operation.type === 'local-restore' ? '本地改动待恢复 · 原始备份已保留' : ['merge', 'rebase'].includes(state.operation.type) ? conflicts.length ? `${state.operation.type === 'rebase' ? '变基' : '合并'}进行中 · ${conflicts.length} 个冲突文件` : `${state.operation.type === 'rebase' ? '变基' : '合并'}待完成` : `Git 操作未完成：${state.operation.type}`}</strong><p>{state.operation.type === 'local-restore' ? '先核对恢复结果。打开冲突文件进行三方合并并标记已解决，再完成恢复；不需要提交本地文件。原始内容可在 Git stash 中查看。' : ['merge', 'rebase'].includes(state.operation.type) ? conflicts.length ? '点击冲突文件使用智能合并，核对结果并暂存后继续；也可中止当前操作。' : '核对暂存内容后继续当前操作。' : '请在原 IDE 或终端完成当前操作，再刷新面板。'}</p>{state.operation.localBackup && state.operation.type !== 'local-restore' && <p>本地改动已自动保存，完成或中止后将恢复。</p>}</div>{state.operation.type === 'local-restore' ? <div className="operation-actions">{['saved', 'preparing'].includes(state.operation.localBackup.phase) && <button disabled={locked || !!state.files.length} onClick={() => setMergeConfirm('restore-retry')}>重试恢复</button>}<button disabled={locked || !!conflicts.length} onClick={() => setMergeConfirm('restore-finish')}>完成恢复</button></div> : ['merge', 'rebase'].includes(state.operation.type) && <div className="operation-actions"><button disabled={locked || !!conflicts.length || state.operation.type === 'rebase' && state.files.some(f => f.unstaged)} onClick={() => setMergeConfirm(state.operation.type + '-continue')}>继续{state.operation.type === 'rebase' ? '变基' : '合并'}</button><button disabled={locked} onClick={() => setMergeConfirm(state.operation.type + '-abort')}>中止{state.operation.type === 'rebase' ? '变基' : '合并'}</button></div>}</section>}
    {(error || notice) && <div role={error ? 'alert' : 'status'} className={`notification ${error ? 'error' : 'success'}`}>{error ? <AlertCircle size={16}/> : <Check size={16}/>}<span>{error || notice}</span><button aria-label="关闭通知" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
    <nav className="work-tabs" aria-label="提交与搁置"><button className={tab === 'work' ? 'active' : ''} aria-current={tab === 'work' ? 'page' : undefined} onClick={() => setTab('work')}>提交 <span>{displayFiles.length}</span></button><button className={tab === 'shelf' ? 'active' : ''} aria-current={tab === 'shelf' ? 'page' : undefined} onClick={() => setTab('shelf')}>搁置</button></nav>
    <div className="workspace">
      {tab === 'shelf' && state ? <Shelves key={id} id={id} state={state} busy={locked} onAction={action}/> : <>
        <aside className="file-pane"><ChangeTree state={state} included={included} onInclude={onInclude} onFile={f => { setPath(f.path); if (f.conflict) setResolvePath(f.path); }} path={path} busy={locked} onMove={moveFiles} onGroup={body => action('changelist', body)} onShelf={requestShelf} onRules={() => setRulesOpen(true)} onPolicy={newFilePolicy => action('changelist', { op: 'policy', newFilePolicy })} onAdd={addFiles}/></aside>
        <InlineEditor repoId={id} path={file ? path : ''} revision={state?.revision} loadFile={p => request(`/api/file?id=${id}`, { path: p })} saveFile={saveFile} onDraftsChange={setDirtyPaths} busy={locked} patch={patch} loading={diffLoading}/>
      </>}
    </div>
    {tab === 'work' && <section className="commit-panel"><div className="commit-heading"><label htmlFor="message">提交信息</label><button disabled={locked || !!state?.operation || !chosenPaths.length || changedDrafts} onClick={() => action('generate-selected', { paths: chosenPaths })} title="AI 分析本次勾选文件的实际修改"><Sparkles size={15}/>{busy ? '处理中…' : 'AI 生成'}</button></div><textarea disabled={busy} id="message" placeholder="描述本次修改…" value={message} onChange={e => setDraft(e.target.value)} spellCheck={false}/>{changed && <div className="message-warning">勾选范围或文件内容已变化，请核对或重新生成提交说明。</div>}{changedDrafts && <div className="message-warning">勾选文件有未保存的编辑，请先在右侧保存。</div>}<div className="commit-actions"><span><Check size={15}/>本次勾选 {chosenPaths.length} 个文件</span><div><button className="primary" disabled={locked || !!state?.operation || !!conflicts.length || !message.trim() || !chosenPaths.length || changedDrafts} onClick={() => commit(false)}>提交</button><button disabled={locked || !!state?.operation || !!conflicts.length || !message.trim() || !chosenPaths.length || changedDrafts} title="提交勾选文件，随后检查远程并推送" onClick={() => commit(true)}><ArrowUp size={15}/>提交并推送</button></div></div></section>}
    <footer>{state ? `${state.files.length} 个更改文件 · ${chosenPaths.length} 个勾选` : isMcp ? 'MCP · 本机 Git' : '本地 Git 工具'}<span className="watch-status" title="监听本地变化，不自动访问远程">{watcher.status}</span><span>{state?.upstream || (state ? '未设置上游' : '代码保留在本机')}</span><small>v0.10.0</small></footer>
    {shelfForm && <Dialog busy={locked} onClose={() => setShelfForm(null)} aria-labelledby="shelf-create-title"><h2 id="shelf-create-title">搁置所选改动</h2><p>保存 {shelfForm.paths.length} 个文件的改动后，将它们从当前工作区撤下。其他文件保留。</p><label htmlFor="shelf-name">搁置名称</label><input id="shelf-name" value={shelfName} onChange={e => setShelfName(e.target.value)} autoFocus maxLength={120}/><div className="dialog-actions"><button onClick={() => setShelfForm(null)}>取消</button><button className="primary" disabled={locked || !shelfName.trim()} onClick={createShelf}>搁置</button></div></Dialog>}
    {rulesOpen && <ExclusionDialog error={error} rules={state?.exclusions || []} busy={locked} onChange={changeRules} onClose={() => setRulesOpen(false)}/>}
    {syncMode && <SyncDialog key={id + syncMode} id={id} mode={syncMode} state={state} onExecute={syncAction} onClose={() => setSyncMode('')}/>}
    {branchOpen && <BranchDialog anchor={branchTrigger.current?.getBoundingClientRect()} key={id} id={id} busy={locked} onState={acceptState} onExecute={branchAction} onClose={() => setBranchOpen(false)}/>}
    {mergeConfirm && (mergeConfirm.startsWith('restore-') ? <RecoveryDialog state={state} mode={mergeConfirm} busy={locked} onExecute={branchAction} onClose={() => setMergeConfirm('')}/> : <MergeDialog state={state} mode={mergeConfirm} busy={locked} onExecute={branchAction} onClose={() => setMergeConfirm('')}/>)}
    {resolvePath && <ConflictDialog key={id + resolvePath} id={id} state={state} onState={acceptState} onNext={setResolvePath} path={resolvePath} busy={locked} onExecute={branchAction} onClose={() => setResolvePath('')}/>}
    {dialog === 'repo' && <Dialog busy={locked} onClose={() => setDialog('')} aria-labelledby="main-dialog-title"><h2 id="main-dialog-title">选择 Git 仓库</h2><div className="project-list">{projects.map(p => <button key={p.root} disabled={locked} onClick={() => openRepo(p.root)}><FolderOpen size={17}/><div><strong>{p.label}</strong><small>{p.root}</small></div></button>)}</div><label htmlFor="repo-root">当前项目仓库 / worktree 的绝对路径</label><input id="repo-root" placeholder="/Users/…/项目目录" value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) openRepo(custom); }}/>{error && <p className="form-error">{error}</p>}<div className="dialog-actions">{state && <button onClick={disconnect}>关闭当前仓库</button>}<button onClick={() => setDialog('')}>取消</button><button className="primary" disabled={locked || !custom.trim()} onClick={() => openRepo(custom)}>打开仓库</button></div></Dialog>}
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
