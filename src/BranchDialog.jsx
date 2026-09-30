import React, { useEffect, useRef, useState } from 'react';
import { GitBranch, GitMerge, Search, X, LoaderCircle } from 'lucide-react';
import { request } from './api';
import Dialog from './Dialog';

export default function BranchDialog({ id, busy, onState, onExecute, onClose, anchor }) {
  const alive = useRef(true), running = useRef(false), list = useRef(null);
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [search, setSearch] = useState(''), [switching, setSwitching] = useState(''), [confirmation, setConfirmation] = useState(null);
  async function read() {
    const next = await request(`/api/branches?id=${id}`);
    if (alive.current) { setData(next); onState(next.state); }
  }
  useEffect(() => {
    alive.current = true;
    read().catch(e => { if (alive.current) setError(e.message); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [id]);
  const blocked = Boolean(data?.state.operation || data?.state.files.some(f => f.conflict));
  const working = busy || loading || !!switching;
  const mergeBlocked = blocked || !data?.state.headRef || !data?.state.head;
  function switchTarget(branch) {
    return branch.type === 'remote' ? data.branches.find(b => b.type === 'local' && b.name === branch.localName) || branch : branch;
  }
  function switchReason(branch) {
    const target = switchTarget(branch);
    return target.current ? '当前分支' : target.type === 'local' && target.worktree && target.worktree !== data.state.root ? '已在其他 worktree 使用' : target.type === 'remote' && !target.localName ? '缺少远程配置' : '';
  }
  async function switchBranch(branch) {
    if (running.current || working || blocked || switchReason(branch)) return;
    running.current = true; setSwitching(branch.ref); setError('');
    const target = switchTarget(branch);
    try {
      const result = await onExecute('switch', { revision: data.state.revision, ref: target.ref, targetOid: target.oid });
      if (!alive.current) return;
      if (result?.status === 'success') onClose();
      else { setError(result?.error || '切换未完成，请检查本地改动后重试。'); await read(); }
    } catch (e) { if (alive.current) setError(e.message); }
    finally { running.current = false; if (alive.current) setSwitching(''); }
  }
  async function prepareMerge(target) {
    if (running.current || working || mergeBlocked) return;
    running.current = true; setError(''); setLoading(true);
    try {
      const args = { revision: data.state.revision, ref: target.ref, targetOid: target.oid };
      const preview = await request(`/api/merge-preview?id=${id}`, args);
      if (alive.current) setConfirmation({ args, ...preview });
    } catch (e) { if (alive.current) setError(e.message); }
    finally { running.current = false; if (alive.current) setLoading(false); }
  }
  async function executeMerge() {
    if (running.current) return;
    running.current = true;
    try {
      const result = await onExecute('merge', confirmation.args);
      if (result && result.status !== 'error') onClose();
      else if (alive.current) setError(result?.error || '合并未完成，请重新核对。');
    } finally { running.current = false; }
  }
  function searchKey(event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector('.branch-choice:not(:disabled)')?.focus(); }
    if (event.key === 'Enter' && search.trim()) {
      event.preventDefault();
      const target = data?.branches.find(b => b.name.toLowerCase().includes(search.toLowerCase()) && !switchReason(b));
      if (target) switchBranch(target);
    }
  }
  function listKey(event) {
    if (!event.target.matches('.branch-choice') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...list.current.querySelectorAll('.branch-choice:not(:disabled)')];
    const index = buttons.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus();
  }
  return <Dialog busy={busy || !!switching || loading && !!confirmation} onClose={onClose} className={`branch-dialog ${confirmation ? '' : 'branch-dropdown'}`} style={!confirmation && anchor ? { top: anchor.bottom + 5, maxHeight: `calc(100dvh - ${anchor.bottom + 17}px)`, left: Math.max(12, Math.min(anchor.left, window.innerWidth - 432)) } : undefined} aria-labelledby="branch-dialog-title">
    <div className="dialog-heading"><h2 id="branch-dialog-title">{confirmation ? '确认合并分支' : 'Git 分支'}</h2><button className="icon-button" aria-label="关闭分支列表" disabled={busy || !!switching} onClick={onClose}><X size={17}/></button></div>
    {error && <p role="alert" className="form-error sync-error">{error}</p>}
    {confirmation ? <>
      <p className="confirm-branch">{confirmation.state.root}</p>
      <div className="branch-direction"><GitBranch size={18}/><strong>{confirmation.target.name}</strong><span>→</span><strong>{confirmation.state.branch}</strong></div>
      <p>将 <strong>{confirmation.target.name}</strong> 合并到当前分支 <strong>{confirmation.state.branch}</strong>。</p>
      <p className="branch-summary">传入 {confirmation.incoming} 个提交 · 当前分支独有 {confirmation.currentOnly} 个提交</p>
      {!confirmation.incoming && <p>当前分支已包含全部提交，无需合并。</p>}
      {!!confirmation.commits.length && <ul className="incoming-commits">{confirmation.commits.map(c => <li key={c.sha}><code>{c.sha}</code><span>{c.subject}</span></li>)}</ul>}
      {confirmation.incoming > 20 && <p>仅列出最近 20 个提交。</p>}
      {!!confirmation.state.files.length && <p className="sync-help">本地改动将自动保存，合并后恢复；不会提交这些文件。</p>}
      <div className="dialog-actions"><button disabled={working} onClick={() => { setConfirmation(null); setError(''); }}>返回分支列表</button><button className="primary" disabled={working || !confirmation.incoming} onClick={executeMerge}>{busy ? '合并中…' : '确认合并'}</button></div>
    </> : <>
      <p className="confirm-branch">当前：<strong>{data?.state.branch || '读取中…'}</strong></p>
      <label className="branch-search" htmlFor="branch-search"><Search size={15}/><input id="branch-search" placeholder="搜索分支，Enter 切换" aria-label="筛选分支名称" value={search} disabled={busy || !!switching} onChange={e => setSearch(e.target.value)} onKeyDown={searchKey} data-dialog-autofocus autoFocus/></label>
      {loading && <p role="status">正在读取分支…</p>}
      {switching && <p role="status" className="sync-progress"><LoaderCircle size={14} className="spinning"/>正在切换分支…</p>}
      <div ref={list} className="branch-list" onKeyDown={listKey}>{['local', 'remote'].map(type => {
        const items = (data?.branches || []).filter(b => b.type === type && b.name.toLowerCase().includes(search.toLowerCase()));
        return <section key={type}><h3>{type === 'local' ? '本地分支' : '远程分支'}</h3>{items.map(b => {
          const reason = switchReason(b), target = switchTarget(b);
          return <div className={`branch-row ${b.current ? 'current' : ''}`} key={b.ref}>
            <button className="branch-choice" aria-label={`切换到 ${b.name}`} title={reason || (target !== b ? `切换到已有本地分支 ${target.name}` : `切换到 ${b.localName || b.name}`)} disabled={working || blocked || !!reason} onClick={() => switchBranch(b)}><GitBranch size={15}/><span><strong>{b.name}</strong><small>{reason || (target !== b ? `本地 ${target.name}` : b.type === 'remote' ? '创建并跟踪本地分支' : b.oid.slice(0, 8))}</small></span>{b.current && <em>当前</em>}</button>
            {!b.current && <button className="branch-merge" aria-label={`将 ${b.name} 合并到当前分支`} title={`合并到 ${data.state.branch}`} disabled={working || mergeBlocked} onClick={() => prepareMerge(b)}><GitMerge size={14}/><span>合并</span></button>}
          </div>;
        })}{!items.length && <p className="branch-empty">{search ? '没有匹配分支' : '暂无分支'}</p>}</section>;
      })}</div>
      {blocked && <p className="message-warning">请先完成或中止当前 Git 操作。</p>}
      <p className="branch-help">点击分支直接切换 · 合并使用行尾按钮 · Esc 或点击外部关闭</p>
    </>}
  </Dialog>;
}

export function MergeDialog({ state, mode, busy, onExecute, onClose }) {
  const revision = useRef(state.revision);
  const abort = mode.endsWith('abort'), operation = mode.startsWith('rebase') ? '变基' : '合并';
  async function execute() { const result = await onExecute(mode, { revision: revision.current }); if (result && result.status !== 'error') onClose(); }
  return <Dialog busy={busy} onClose={onClose} aria-labelledby="merge-dialog-title">
    <h2 id="merge-dialog-title">{`确认${abort ? '中止' : '继续'}${operation}`}</h2>
    <p className="confirm-branch">{state.root} · {state.branch}</p>
    {abort ? <p>中止当前{operation}，放弃本次冲突解决期间的修改，尝试恢复操作前的状态。</p> : <><p>继续当前{operation}，使用已解决并暂存的内容：</p><ul className="confirm-files">{state.files.filter(f => f.staged).map(f => <li key={f.path}>{f.path}</li>)}</ul><pre className="confirm-message">{state.operation?.message}</pre></>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>返回检查</button><button className={abort ? 'danger' : 'primary'} disabled={busy} onClick={execute}>{busy ? '操作中…' : abort ? '确认中止' : `确认继续${operation}`}</button></div>
  </Dialog>;
}

export function ResolveDialog({ state, path, busy, onExecute, onClose }) {
  const revision = useRef(state.revision);
  async function execute() { const result = await onExecute('resolve', { revision: revision.current, path }); if (result && result.status !== 'error') onClose(); }
  return <Dialog busy={busy} onClose={onClose} aria-labelledby="resolve-dialog-title">
    <h2 id="resolve-dialog-title">确认标记已解决</h2><p className="confirm-branch">{path}</p>
    <p>请确认已在编辑器完成冲突处理。本操作会将此文件的当前内容加入暂存区；残留冲突标记会被拒绝。</p>
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>返回检查</button><button className="primary" disabled={busy} onClick={execute}>{busy ? '操作中…' : '确认已解决并暂存'}</button></div>
  </Dialog>;
}

export function RecoveryDialog({ state, mode, busy, onExecute, onClose }) {
  const revision = useRef(state.revision);
  const [confirmed, setConfirmed] = useState(false);
  const finish = mode === 'restore-finish', backup = state.operation.localBackup;
  async function execute() { const result = await onExecute(mode, { revision: revision.current }); if (result && result.status !== 'error') onClose(); }
  return <Dialog busy={busy} onClose={onClose} aria-labelledby="recovery-dialog-title">
    <h2 id="recovery-dialog-title">{finish ? '核对并完成本地改动恢复' : '重试恢复本地改动'}</h2>
    <p>备份名称：<code>{backup.label}</code></p>
    <p>原始文件内容保留在 Git stash 中。恢复有冲突或同名文件时，请先在编辑器核对、处理这些文件；不会自动把它们提交。</p>
    <pre className="confirm-message">{`git stash show --include-untracked ${backup.oid || ''}`}</pre>
    {finish ? <><p>确认后保留当前工作区的所有文件，取消当前暂存状态，结束恢复。原始备份仍会保留，便于继续核对或取回未恢复的文件。</p><label className="check-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对本地文件，保留当前内容并全部取消暂存</label></> : <p>只重试尚未开始的恢复，不会重复应用已发生冲突的备份。</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>返回检查</button><button className="primary" disabled={busy || finish && !confirmed} onClick={execute}>{finish ? '确认完成恢复' : '确认重试恢复'}</button></div>
  </Dialog>;
}
