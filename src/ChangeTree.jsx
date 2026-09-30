import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Plus, Settings2, Archive, Search, Pencil, Check } from 'lucide-react';
import Dropdown from './Dropdown';
import { changeGroups } from './changes';
import { selectPath } from './selection';

function GroupCheck({ checked, mixed, ...props }) {
  const ref = useRef();
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" checked={checked} {...props}/>;
}
export default function ChangeTree({ state, included, onInclude, onFile, path, busy, onMove, onGroup, onShelf, onRules, onPolicy, onAdd }) {
  const [filter, setFilter] = useState(''), [selected, setSelected] = useState(new Set()), [collapsed, setCollapsed] = useState(new Set());
  const [form, setForm] = useState(null), [name, setName] = useState(''), [settings, setSettings] = useState(false);
  const anchor = useRef(null), tree = useRef(null);
  const groups = changeGroups(state?.files || [], state?.changelists);
  const visibleGroups = groups.map(g => ({ ...g, files: g.files.filter(f => f.path.toLowerCase().includes(filter.toLowerCase())) }));
  const visibleFiles = visibleGroups.flatMap(g => collapsed.has(g.id) ? [] : g.files);
  const allPaths = visibleFiles.map(f => f.path), selectedFiles = (state?.files || []).filter(f => selected.has(f.path));
  const selectedNames = selectedFiles.map(f => f.path);
  const eligible = selectedFiles.filter(f => !f.excluded && !f.conflict).map(f => f.path);
  const normalGroups = groups.filter(g => g.type === 'list');
  useEffect(() => { setSelected(new Set()); anchor.current = null; setFilter(''); setForm(null); }, [state?.root]);
  function select(file, event) {
    const next = selectPath(allPaths, selected, anchor.current, file.path, { shift: event.shiftKey, additive: event.ctrlKey || event.metaKey });
    setSelected(next.paths); anchor.current = next.anchor; onFile(file);
  }
  function toggle(id) { setCollapsed(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function submitGroup(event) { event.preventDefault(); const result = await onGroup({ op: form.id ? 'rename' : 'create', groupId: form.id, name }); if (result) { setForm(null); setName(''); } }
  async function move(groupId, paths = selectedNames) { if (paths.length && await onMove(groupId, paths)) setSelected(previous => new Set([...previous].filter(path => !paths.includes(path)))); }
  function keyDown(event) {
    if (!event.target.classList.contains('file-name')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(new Set(allPaths)); return; }
    if (event.key === 'Escape') { setSelected(new Set()); return; }
    if (event.key === ' ') { event.preventDefault(); onInclude(eligible, !eligible.every(p => included.has(p))); return; }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault(); const index = allPaths.indexOf(event.target.dataset.path), next = visibleFiles[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { select(next, event); [...tree.current.querySelectorAll('.file-name')].find(b => b.dataset.path === next.path)?.focus(); }
  }
  const untracked = (state?.files || []).filter(f => f.code === '??' && !f.excluded);
  return <>
    <div className="changes-tools"><span>更改列表</span><button className="icon-button" aria-label="新建分组" title="新建更改列表" disabled={busy || !state} onClick={() => { setForm({}); setName(''); }}><Plus size={15}/></button><button className="icon-button" aria-label="文件分组设置" title="文件分组设置" onClick={() => setSettings(!settings)} aria-expanded={settings}><Settings2 size={15}/></button></div>
    {settings && <div className="changes-settings"><label>发现新文件时</label><Dropdown label="新文件处理方式" value={state?.changelists?.newFilePolicy || 'manual'} options={[{ value: 'manual', label: '归入未受版本控制，不提示' }, { value: 'ask', label: '提示是否添加到 Git' }, { value: 'auto', label: '自动添加到 Git' }]} disabled={busy} onChange={onPolicy}/><button onClick={onRules} disabled={busy}>管理永不提交规则</button></div>}
    {form && <form className="group-form" onSubmit={submitGroup}><input aria-label="分组名称" placeholder="分组名称" value={name} maxLength={80} autoFocus onChange={e => setName(e.target.value)}/><button type="submit" className="icon-button" aria-label="保存分组" disabled={busy || !name.trim()}><Check size={14}/></button><button type="button" aria-label="取消编辑分组" onClick={() => setForm(null)}>×</button></form>}
    <label className="search"><Search size={14}/><input aria-label="筛选文件" placeholder="筛选文件" value={filter} onChange={e => setFilter(e.target.value)}/></label>
    {state?.changelists?.newFilePolicy === 'ask' && !!untracked.length && <div className="new-file-notice"><span>发现 {untracked.length} 个新文件</span><button disabled={busy} onClick={() => onAdd(untracked.map(f => f.path))}>添加到 Git</button><button onClick={() => onPolicy('manual')} disabled={busy}>不再提示</button></div>}
    {!!selectedFiles.length && <div className="tree-selection"><span>已选 {selectedFiles.length}</span><Dropdown label="移动所选文件到分组" placeholder="移动到…" value="" options={[...normalGroups.map(g => ({ value: g.id, label: g.name })), { value: 'excluded', label: '永不提交' }]} disabled={busy} onChange={move}/><button title="搁置选中文件的本地改动" disabled={busy || selectedFiles.some(f => f.conflict)} onClick={() => onShelf(selectedNames)}><Archive size={13}/>搁置</button><button className="text-button" disabled={busy || !eligible.length} onClick={() => onInclude(eligible, !eligible.every(p => included.has(p)))}>{eligible.length && eligible.every(p => included.has(p)) ? '取消勾选' : '勾选提交'}</button><button className="text-button" aria-label="清除文件多选" onClick={() => setSelected(new Set())}>清除</button></div>}
    <div className="file-list changes-tree" ref={tree} aria-label="更改文件分组" onKeyDown={keyDown}>
      {visibleGroups.map(group => {
        const checkable = group.files.filter(f => !f.excluded && !f.conflict).map(f => f.path), count = checkable.filter(p => included.has(p)).length;
        return <section key={group.id} className="change-group" aria-label={group.name}>
          <div className={`group-row ${state?.changelists?.activeId === group.id ? 'default-group' : ''}`} onDragOver={e => { if (!busy && group.type !== 'unversioned' && e.dataTransfer.types.includes('application/x-git-panel-paths')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }} onDrop={e => { e.preventDefault(); try { const data = JSON.parse(e.dataTransfer.getData('application/x-git-panel-paths')); if (data.root === state.root) move(group.id, data.paths); } catch {} }}>
            <button className="disclosure" aria-label={`${collapsed.has(group.id) ? '展开' : '折叠'}${group.name}`} aria-expanded={!collapsed.has(group.id)} onClick={() => toggle(group.id)}>{collapsed.has(group.id) ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}</button>
            <GroupCheck aria-label={`本次提交包含${group.name}`} checked={!!checkable.length && count === checkable.length} mixed={count > 0 && count < checkable.length} disabled={busy || !checkable.length} onChange={e => onInclude(checkable, e.target.checked)}/>
            <button className="group-name" onClick={() => toggle(group.id)} title={group.name}>{group.name}</button><small>{group.files.length}</small>
            {state?.changelists?.activeId === group.id && <span className="active-list" title="新修改默认归入此分组">默认</span>}
            {group.type === 'list' && <div className="group-actions">{group.id !== 'changes' && <button className="icon-button" title="重命名分组" aria-label={`重命名${group.name}`} disabled={busy} onClick={() => { setForm({ id: group.id }); setName(group.name); }}><Pencil size={12}/></button>}{state?.changelists?.activeId !== group.id && <button className="icon-button" aria-label={`将${group.name}设为默认`} title="设为默认分组" disabled={busy} onClick={() => onGroup({ op: 'set-active', groupId: group.id })}><Check size={12}/></button>}<button className="icon-button" aria-label={`搁置${group.name}`} title="搁置此分组" disabled={busy || !group.files.length || group.files.some(f => f.conflict)} onClick={() => onShelf(group.files.map(f => f.path), group.id)}><Archive size={12}/></button></div>}
          </div>
          {!collapsed.has(group.id) && group.files.map(file => <div key={file.path} className={`file-row tree-file ${selected.has(file.path) ? 'selected' : ''} ${path === file.path ? 'preview' : ''}`} draggable={!busy && !file.conflict} onDragStart={e => { const paths = selected.has(file.path) ? selectedNames : [file.path]; e.dataTransfer.setData('application/x-git-panel-paths', JSON.stringify({ root: state.root, paths })); e.dataTransfer.effectAllowed = 'move'; }} onClick={e => { if (!e.target.closest('input')) select(file, e); }}>
            <input type="checkbox" aria-label={`本次提交包含 ${file.path}`} checked={!file.excluded && included.has(file.path)} disabled={busy || file.excluded || file.conflict} title={file.excluded ? '移出永不提交分组后可勾选' : '仅选择本次提交，不改变暂存区'} onChange={e => onInclude([file.path], e.target.checked)} onClick={e => e.stopPropagation()}/>
            <button className="file-name" data-path={file.path} aria-pressed={selected.has(file.path)} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}><span>{file.path.split('/').at(-1)}</span><small>{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''}</small></button><span className={`status status-${file.conflict ? 'U' : file.code === '??' ? 'new' : file.kind}`}>{file.conflict ? '!' : file.code === '??' ? '?' : file.kind}</span>
          </div>)}
        </section>;
      })}
      {!state && <div className="list-empty">请选择仓库</div>}
      {state && !state.files.length && <div className="list-empty">工作区没有改动</div>}
    </div><div className="tree-hint">Shift 连选 · ⌘ / Ctrl 多选 · 拖动整理分组</div>
  </>;
}
