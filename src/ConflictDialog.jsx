import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, Undo2, ChevronUp, ChevronDown, RefreshCw } from 'lucide-react';
import Dialog from './Dialog';
import { request } from './api';
import { storage } from './storage';
import { conflictParts, mergeChoices, hasConflictMarkers } from './conflicts';

export default function ConflictDialog({ id, state, path, busy, onState, onExecute, onClose, onNext }) {
  const alive = useRef(true), running = useRef(false), blocksRef = useRef(null);
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [draft, setDraft] = useState({ content: '', choices: {}, deleted: false, manual: false });
  const [history, setHistory] = useState([]), [suggestion, setSuggestion] = useState(null), [generating, setGenerating] = useState(false);
  const [baseOpen, setBaseOpen] = useState(false), [activeBlock, setActiveBlock] = useState(0);
  const locked = busy || loading || generating;
  const parts = useMemo(() => data?.canAuto ? conflictParts(data.automatic) : [], [data]);
  const blocks = parts.filter(p => p.index !== undefined);
  const key = data && `git-panel-conflict:${state.root}:${path}:${data.token}`;
  useEffect(() => { if (key) storage.set(key, JSON.stringify(draft)); }, [key, draft]);
  async function read(fresh = false) {
    setLoading(true); setError('');
    try {
      const nextState = fresh ? await request(`/api/state?id=${id}`) : state;
      const next = await request(`/api/conflict?id=${id}`, { path, revision: nextState.revision });
      if (!alive.current) return;
      const draftKey = `git-panel-conflict:${state.root}:${path}:${next.token}`;
      let saved = null; try { saved = JSON.parse(storage.get(draftKey) || 'null'); } catch {}
      const edited = next.workExists && !hasConflictMarkers(next.work);
      setDraft(saved && typeof saved.content === 'string' && typeof saved.deleted === 'boolean' && saved.choices && typeof saved.manual === 'boolean' ? saved : { content: edited ? next.work : next.canAuto ? next.automatic : next.work || '', choices: {}, deleted: !next.workExists && !next.canAuto, manual: edited });
      setData(next); onState(next.state); setHistory([]); setSuggestion(null); setActiveBlock(0);
    } catch (e) { if (alive.current) setError(e.message); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; read(); return () => { alive.current = false; }; }, [id, path]);
  function replace(next) { setHistory(current => [...current.slice(-19), draft]); setDraft(next); }
  function choose(block, side) {
    const value = side === 'both' ? block.left + block.right : block[side];
    const choices = { ...draft.choices, [block.index]: value };
    replace({ content: draft.manual ? draft.content.replace(block.raw, value) : mergeChoices(parts, choices), choices, deleted: false, manual: draft.manual });
  }
  function chooseFile(side) { const version = data.versions[side]; replace({ content: version.text || '', choices: {}, deleted: !version.exists, manual: true }); }
  function jump(offset) {
    const index = (activeBlock + offset + blocks.length) % blocks.length;
    setActiveBlock(index); blocksRef.current?.querySelector(`[data-block="${index}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  async function generate() {
    if (running.current || locked) return;
    running.current = true; setGenerating(true); setError('');
    try {
      const result = await request(`/api/action?id=${id}`, { action: 'conflict-ai', revision: data.state.revision, path, token: data.token });
      if (alive.current) setSuggestion(result);
    } catch (e) { if (alive.current) setError(e.message); }
    finally { running.current = false; if (alive.current) setGenerating(false); }
  }
  async function apply(external = false) {
    if (running.current || locked) return;
    running.current = true; setError('');
    try {
      const result = await onExecute(external ? 'resolve' : 'conflict-apply', { revision: data?.state.revision || state.revision, path, ...(external ? {} : { token: data.token, content: draft.content, deleted: draft.deleted }) });
      if (!alive.current) return;
      if (result?.status === 'success' || result && !result.status) {
        if (key) storage.remove(key);
        const next = !external && result.state.files.find(f => f.conflict);
        if (next && onNext) onNext(next.path); else onClose();
      }
      else if (result?.status === 'apply-pending') onClose();
      else setError(result?.error || '应用未完成，草稿已保留。请重新读取后核对。');
    } finally { running.current = false; }
  }
  return <Dialog className="conflict-dialog" busy={busy} onClose={onClose} aria-labelledby="conflict-title">
    <div className="dialog-heading"><h2 id="conflict-title">解决冲突 · 智能合并</h2><button className="icon-button" aria-label="关闭冲突窗口" disabled={busy} onClick={onClose}><X size={17}/></button></div>
    <p className="conflict-path" title={path}>{path}</p>
    <div className="conflict-toolbar"><button disabled={locked} onClick={() => read(true)}><RefreshCw size={13}/>重新读取</button><button disabled={locked || !history.length} onClick={() => { setDraft(history.at(-1)); setHistory(history.slice(0, -1)); }}><Undo2 size={13}/>撤销操作</button>{data?.supported && <button disabled={locked} aria-pressed={baseOpen} onClick={() => setBaseOpen(!baseOpen)}>{baseOpen ? '收起' : '查看'}共同基础</button>}<button disabled={locked || !data?.canAuto || !data.count} onClick={generate} title="分析共同基础和两边实际代码，只提供冲突块建议"><Sparkles size={13}/>{generating ? 'AI 分析中…' : 'AI 智能合并'}</button></div>
    {error && <p className="form-error sync-error" role="alert">{error}</p>}
    {loading && <p role="status">正在读取三方版本…</p>}
    {data && !data.supported && <p className="message-warning">{data.reason}</p>}
    {data?.supported && <>
      <p className="sync-help conflict-help">{data.canAuto ? `Git 已合并不重叠的修改，${data.count} 个冲突块待核对。` : '此文件涉及删除，请明确选择保留哪一版。'}关闭窗口保留草稿；应用仅处理此文件。</p>
      {baseOpen && <div className="conflict-base"><strong>共同基础{!data.versions.base.exists && '（文件尚不存在）'}</strong><pre>{data.versions.base.text}</pre></div>}
      <div className="merge-editors">
        <section className="merge-source"><div className="merge-editor-heading"><label htmlFor="merge-left">{data.labels.left}</label><button disabled={locked} onClick={() => chooseFile('left')}>{data.versions.left.exists ? '整文件保留左侧' : '采用左侧删除'}</button></div><textarea id="merge-left" value={data.versions.left.text || ''} readOnly spellCheck={false} wrap="off" placeholder={data.versions.left.exists ? '' : '此版本已删除文件'}/></section>
        <section className="merge-result"><div className="merge-editor-heading"><label htmlFor="merge-result">合并结果 · 可编辑</label><span>{draft.deleted ? '删除文件' : hasConflictMarkers(draft.content) ? '仍有冲突标记' : '可应用'}</span></div><textarea id="merge-result" value={draft.content} disabled={locked || draft.deleted} spellCheck={false} wrap="off" aria-describedby="merge-result-help" onChange={e => setDraft({ ...draft, content: e.target.value, manual: true })}/><p id="merge-result-help">{draft.deleted ? '应用时删除此文件；可选择另一侧恢复为保留文件。' : draft.manual ? '手动编辑中。选择整文件版本或采用 AI 建议会替换此草稿，可撤销。' : '逐块选择两侧内容，也可以直接编辑结果。'}</p></section>
        <section className="merge-source"><div className="merge-editor-heading"><label htmlFor="merge-right">{data.labels.right}</label><button disabled={locked} onClick={() => chooseFile('right')}>{data.versions.right.exists ? '整文件保留右侧' : '采用右侧删除'}</button></div><textarea id="merge-right" value={data.versions.right.text || ''} readOnly spellCheck={false} wrap="off" placeholder={data.versions.right.exists ? '' : '此版本已删除文件'}/></section>
      </div>
      {!!blocks.length && <>
        <div className="conflict-block-heading"><strong>逐块处理 {activeBlock + 1} / {blocks.length}</strong><div><button aria-label="上一个冲突块" disabled={locked} onClick={() => jump(-1)}><ChevronUp size={13}/></button><button aria-label="下一个冲突块" disabled={locked} onClick={() => jump(1)}><ChevronDown size={13}/></button><button disabled={locked} onClick={() => replace({ content: data.automatic, choices: {}, deleted: false, manual: false })}>重置为自动草稿</button></div></div>
        <div className="conflict-blocks" ref={blocksRef}>{blocks.map(block => <section className={`conflict-block ${draft.choices[block.index] !== undefined && !draft.content.includes(block.raw) ? 'resolved' : ''}`} key={block.index} data-block={block.index}>
          <div className="conflict-block-heading"><strong>冲突 {block.index + 1}{draft.choices[block.index] !== undefined && !draft.content.includes(block.raw) ? ' · 已选择' : ''}</strong><div><button disabled={locked || draft.manual && !draft.content.includes(block.raw)} onClick={() => choose(block, 'left')}>保留左侧</button><button disabled={locked || draft.manual && !draft.content.includes(block.raw)} onClick={() => choose(block, 'right')}>保留右侧</button><button disabled={locked || draft.manual && !draft.content.includes(block.raw)} onClick={() => choose(block, 'both')} title="先左后右保留此块内容，需核对重复逻辑">保留两边</button></div></div><div className="conflict-block-code"><pre aria-label={`冲突 ${block.index + 1} 左侧`}>{block.left || '（删除）'}</pre><pre aria-label={`冲突 ${block.index + 1} 右侧`}>{block.right || '（删除）'}</pre></div>
        </section>)}</div>
      </>}
      {suggestion && <section className="merge-suggestion"><strong>AI 合并建议 · 尚未应用</strong><p>{suggestion.explanation}</p>{suggestion.warnings.length > 0 && <ul className="message-warning">{suggestion.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}<pre>{suggestion.content}</pre><button disabled={locked} onClick={() => { replace({ content: suggestion.content, choices: {}, deleted: false, manual: true }); setSuggestion(null); }}>采用建议到编辑区</button><button disabled={locked} onClick={() => setSuggestion(null)}>忽略建议</button></section>}
    </>}
    <div className="dialog-actions"><button disabled={locked} onClick={() => apply(true)} title="使用外部编辑器处理后的工作区文件">外部已处理，标记已解决</button><button disabled={busy} onClick={onClose}>关闭</button>{data?.supported && <button className="primary" disabled={locked || !draft.deleted && hasConflictMarkers(draft.content)} onClick={() => apply()}>{busy ? '应用中…' : state.files.filter(f => f.conflict).length > 1 ? '应用并处理下一个' : draft.deleted ? '应用删除并暂存' : '应用结果并暂存'}</button>}</div>
  </Dialog>;
}
