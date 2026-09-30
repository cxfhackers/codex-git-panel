import React, { useEffect, useState } from 'react';
import { Archive, FileDiff } from 'lucide-react';
import Dropdown from './Dropdown';
import Diff from './Diff';
import { request } from './api';

export default function Shelves({ id, state, busy, onAction }) {
  const [shelves, setShelves] = useState([]), [active, setActive] = useState(''), [included, setIncluded] = useState(new Set());
  const [path, setPath] = useState(''), [patch, setPatch] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [groupId, setGroupId] = useState(state.changelists?.activeId || 'changes'), [conflicts, setConflicts] = useState([]), [resolutions, setResolutions] = useState({});
  const shelf = shelves.find(s => s.id === active);
  useEffect(() => { let live = true; request(`/api/shelves?id=${id}`).then(data => { if (live) setShelves(data.shelves); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [id, state]);
  useEffect(() => { let live = true; setPatch(''); if (!active || !path) return; setLoading(true); request(`/api/shelf-diff?id=${id}`, { shelfId: active, path }).then(data => { if (live) setPatch(data.patch); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [id, active, path]);
  function choose(s) { setGroupId(state.changelists?.groups.some(g => g.id === s.groupId) ? s.groupId : state.changelists?.activeId || 'changes'); setActive(s.id); setIncluded(new Set(s.files.map(f => f.path))); setPath(s.files[0]?.path || ''); setConflicts([]); setResolutions({}); setError(''); }
  async function restore() {
    const result = await onAction('shelf-restore', { shelfId: active, paths: [...included], groupId, resolutions: conflicts.map(c => ({ path: c.path, token: c.token, ...(resolutions[c.path] || {}) })) });
    if (!result) return;
    if (result.status === 'conflict') { setConflicts(result.conflicts); setResolutions({}); }
    else { setConflicts([]); setError(result.warning || ''); if (result.shelf) setShelves(previous => previous.map(s => s.id === result.shelf.id ? result.shelf : s)); }
  }
  const conflict = conflicts.find(c => c.path === path) || conflicts[0];
  const hasMarkers = text => /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(text || '');
  const resolved = conflicts.every(c => !!resolutions[c.path] && !hasMarkers(resolutions[c.path].content));
  return <>
    <aside className="file-pane shelf-pane"><div className="changes-tools"><Archive size={14}/><span>搁置的更改</span><small>{shelves.length}</small></div><div className="file-list">
      {shelves.map(s => <section key={s.id} className="shelf-record"><button className={`shelf-title ${active === s.id ? 'selected' : ''}`} disabled={busy} onClick={() => choose(s)}><Archive size={14}/><span><strong>{s.name}</strong><small>{new Date(s.createdAt).toLocaleString()} · {s.files.length} 个文件{state.changelists?.groups.find(g => g.id === s.groupId) ? ` · ${state.changelists.groups.find(g => g.id === s.groupId).name}` : ''}</small></span></button>{active === s.id && s.files.map(f => <div key={f.path} className={`file-row tree-file ${path === f.path ? 'selected' : ''}`}><input type="checkbox" aria-label={`恢复 ${f.path}`} checked={included.has(f.path)} disabled={busy} onChange={e => { setConflicts([]); setIncluded(prev => { const next = new Set(prev); e.target.checked ? next.add(f.path) : next.delete(f.path); return next; }); }}/><button className="file-name" onClick={() => setPath(f.path)} title={f.path}><span>{f.path.split('/').at(-1)}</span><small>{f.path.slice(0, f.path.lastIndexOf('/') + 1)}</small></button>{s.restoredPaths?.includes(f.path) && <small>已恢复</small>}</div>)}</section>)}
      {!shelves.length && <div className="list-empty">还没有搁置内容<br/>在提交列表中多选文件后点击“搁置”</div>}
    </div>{shelf && <div className="shelf-actions"><label>恢复到分组</label><Dropdown label="搁置恢复目标分组" value={groupId} options={(state.changelists?.groups || []).map(g => ({ value: g.id, label: g.name }))} onChange={setGroupId} disabled={busy}/><button className="primary" disabled={busy || !included.size || conflicts.length > 0 && !resolved} onClick={restore}>{busy ? '正在恢复…' : `恢复所选 ${included.size} 个文件`}</button><small>恢复后保留副本；新文件加入 Git</small></div>}</aside>
    <section className="shelf-preview">{error && <div className="notification error" role="alert">{error}</div>}{conflict ? <div className="shelf-conflict"><header><h3>核对搁置恢复冲突</h3><p>本地文件尚未覆盖。逐个选择要保留的结果，再恢复所选文件。</p><Dropdown label="待处理的搁置冲突" value={conflict.path} options={conflicts.map(c => ({ value: c.path, label: `${resolutions[c.path] ? '✓ ' : ''}${c.path}` }))} onChange={setPath}/></header><div className="shelf-three-way">{[['共同基础', conflict.base], ['当前文件', conflict.current], ['搁置内容', conflict.incoming]].map(([title, text]) => <section key={title}><strong>{title}</strong><pre>{typeof text === 'string' ? text : text?.content ?? '此版本不存在，或为非文本内容'}</pre></section>)}</div><div className="shelf-resolution"><button disabled={busy} onClick={() => setResolutions(r => ({ ...r, [conflict.path]: { choice: 'current' } }))}>保留当前文件</button><button disabled={busy} onClick={() => setResolutions(r => ({ ...r, [conflict.path]: { choice: 'shelf' } }))}>使用搁置版本</button>{conflict.canEdit && typeof conflict.merged === 'string' && <><textarea disabled={busy} aria-label="搁置冲突合并结果" spellCheck={false} value={resolutions[conflict.path]?.content ?? conflict.merged} onChange={e => setResolutions(r => ({ ...r, [conflict.path]: { content: e.target.value } }))}/><button disabled={busy || hasMarkers(resolutions[conflict.path]?.content ?? conflict.merged)} onClick={() => setResolutions(r => ({ ...r, [conflict.path]: { content: r[conflict.path]?.content ?? conflict.merged } }))}>采用编辑后的结果</button></>}{resolutions[conflict.path] && <span>此文件的恢复方式已选择</span>}</div></div> : <Diff path={path} patch={patch} loading={loading} file={null}/>}{!shelf && <div className="shelf-empty-overlay"><FileDiff size={28}/><p>选择一份搁置内容查看差异</p></div>}</section>
  </>;
}
