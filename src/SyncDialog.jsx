import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, ArrowRight, ArrowUp, ArrowDown } from 'lucide-react';
import { request } from './api';
import Dialog from './Dialog';
import Dropdown from './Dropdown';
import { storage } from './storage';

export default function SyncDialog({ id, mode, state, onExecute, onClose }) {
  const active = useRef(true), working = useRef(false);
  const [target, setTarget] = useState(null);
  const [strategy, setStrategy] = useState(() => storage.get('git-panel-sync-strategy:' + state.root) === 'rebase' ? 'rebase' : 'merge');
  const [executing, setExecuting] = useState(false);
  const [preview, setPreview] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [warning, setWarning] = useState('');
  useEffect(() => {
    active.current = true;
    (async () => {
      try {
        const data = await request(`/api/sync-targets?id=${id}`);
        if (!active.current) return;
        setTarget(data);
        if (data.remote && data.branch) await check({ remote: data.remote, branch: data.branch, strategy, setUpstream: data.setUpstream });
        else setError('当前仓库没有可用的远程，请先配置 Git remote 后重新打开。');
      } catch (e) { if (active.current) setError(e.message); }
      finally { if (active.current) setLoading(false); }
    })();
    return () => { active.current = false; };
  }, []);
  async function check(values = { remote: target?.remote, branch: target?.branch, strategy, setUpstream: target?.setUpstream }) {
    if (working.current) return;
    working.current = true; setLoading(true); setError(''); setWarning(''); setPreview(null);
    try {
      const result = await onExecute('sync-check', { revision: state.revision, ...values });
      if (!active.current) return;
      if (!result || result.status === 'error') setError(result?.error || '检查失败，请重试');
      else setPreview(result);
    } finally { working.current = false; if (active.current) setLoading(false); }
  }
  function changeStrategy(value) {
    setStrategy(value); setPreview(null); setWarning(''); setError('');
    storage.set('git-panel-sync-strategy:' + state.root, value);
    if (target?.remote && target.branch) check({ remote: target.remote, branch: target.branch, strategy: value, setUpstream: target.setUpstream });
  }
  async function execute() {
    if (working.current || !preview) return;
    working.current = true; setLoading(true); setExecuting(true); setError('');
    try {
      const result = await onExecute(mode === 'update' ? 'sync-update' : 'push', { revision: preview.state.revision, previewToken: preview.previewToken });
      if (!active.current) return;
      if (result?.status === 'remote-changed') { setPreview(result); setWarning(result.warning); }
      else if (result?.status === 'conflict' || result?.status === 'merge-pending' || result?.status === 'restore-conflict' || result?.status === 'success') onClose();
      else { setPreview(null); setError([result?.error || result?.warning || '操作未完成，请重新检查', result?.output].filter(Boolean).join('\n')); }
    } finally { working.current = false; if (active.current) { setLoading(false); setExecuting(false); } }
  }
  const canExecute = preview && (mode === 'push' ? preview.ahead > 0 || preview.behind > 0 || !preview.remoteExists || preview.target.setUpstream : preview.behind > 0);
  const title = mode === 'update' ? '更新当前分支' : '推送提交';
  return <Dialog busy={executing} onClose={onClose} className="sync-dialog" aria-labelledby="sync-title">
    <h2 id="sync-title">{title}</h2>
    <p className="sync-help">{mode === 'push' ? '包含当前分支所有尚未推送的提交；未提交的文件不会被推送。' : '获取远程提交，并按选择的方式更新本地分支。'}</p>
    {(mode === 'update' || preview?.behind > 0) && <><div className="sync-options"><div className="sync-strategy"><span>更新方式</span><Dropdown label="更新方式" value={strategy} options={[{ value: 'merge', label: '合并 Merge' }, { value: 'rebase', label: '变基 Rebase' }]} disabled={loading} onChange={changeStrategy}/></div></div><p className="sync-help">合并保留提交历史；变基将本地提交重新应用到远程提交之后。</p></>}
    {loading && <p role="status" className="sync-progress"><RefreshCw size={16} className="spinning"/>正在检查或同步，请稍候…</p>}
    {error && <p role="alert" className="form-error sync-error">{error}</p>}{warning && <p role="status" className="message-warning">{warning}</p>}
    {preview && <>
      {preview.behind > 0 && preview.state.files.length > 0 && <p className="sync-help">将自动保存本地改动（包含未跟踪文件），更新后恢复，不会提交这些文件；恢复冲突时暂停推送并保留备份。</p>}
      <div className="branch-direction"><strong>{preview.state.branch}</strong><ArrowRight size={16}/><strong>{preview.target.name}</strong></div>
      {mode === 'push' && preview.target.setUpstream && <p className="sync-help">推送成功后将自动设置此远程分支为上游。</p>}
      <div className="sync-counts"><span><ArrowUp size={16}/>待推送 {preview.ahead}</span><span><ArrowDown size={16}/>待更新 {preview.behind}</span><small>已检查远程 · {new Date(preview.checkedAt).toLocaleTimeString()}</small></div>
      {!preview.remoteExists && <p className="message-warning">远程分支尚不存在，推送将创建该分支。</p>}
      <CommitList title="待推送提交" commits={preview.outgoing}/><CommitList title="远程待更新提交" commits={preview.incoming}/>
      {preview.ahead === 0 && preview.behind === 0 && preview.remoteExists && <p className="sync-help">本地与远程已同步。</p>}
      <p className="sync-help">每组最多展示最近 20 个提交。{preview.behind > 0 && mode === 'push' ? `确认后先${strategy === 'merge' ? '合并' : '变基'}更新，成功后推送；冲突时暂停。` : ''}</p>
    </>}
    <div className="dialog-actions"><button type="button" disabled={executing} onClick={onClose}>取消</button><button type="button" disabled={loading || !target?.remote || !target.branch} onClick={() => check()}><RefreshCw size={14}/>重新检查</button><button type="button" className="primary" disabled={loading || !canExecute} onClick={execute}>{mode === 'update' ? '确认更新' : preview?.behind > 0 ? '更新并推送' : '确认推送'}</button></div>
  </Dialog>;
}
function CommitList({ title, commits }) { return commits.length ? <section className="sync-commits"><h3>{title}</h3><ul className="incoming-commits">{commits.map(c => <li key={c.sha}><code>{c.sha}</code><span>{c.subject}</span></li>)}</ul></section> : null; }
