import React, { useEffect, useRef, useState } from 'react';
import { AlignLeft, Columns2, FileDiff, Save, Undo2, Redo2 } from 'lucide-react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyField, historyKeymap, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { javascript } from '@codemirror/lang-javascript';
import { java } from '@codemirror/lang-java';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import './InlineEditor.css';

// Drafts and undo history survive file switches and temporary pane unmounts.
// Nothing is persisted outside this window or sent to Git until the user saves.
const drafts = new Map();
const normalize = text => text.replace(/\r\n/g, '\n');
const dirty = entry => !!entry?.base && entry.content !== normalize(entry.base.content);
const draftKey = (repoId, path) => JSON.stringify([repoId, path]);
let guardingUnload = false;
function beforeUnload(event) {
  if ([...drafts.values()].some(dirty)) { event.preventDefault(); event.returnValue = ''; }
}
function syncDraftGuard() {
  const needed = [...drafts.values()].some(dirty);
  if (needed === guardingUnload) return;
  window[needed ? 'addEventListener' : 'removeEventListener']('beforeunload', beforeUnload);
  guardingUnload = needed;
}
export function dirtyEditorPaths(repoId) {
  return [...drafts.values()].filter(entry => entry.repoId === repoId && dirty(entry)).map(entry => entry.path);
}
function compactCleanDrafts() {
  const clean = [...drafts.entries()].filter(([, entry]) => !dirty(entry));
  for (const [key] of clean.slice(0, Math.max(0, clean.length - 30))) drafts.delete(key);
}
function language(path) {
  if (/\.[cm]?[jt]sx?$/i.test(path)) return javascript({ jsx: /x$/i.test(path), typescript: /\.[cm]?tsx?$/i.test(path) });
  if (/\.java$/i.test(path)) return java();
  if (/\.(json|jsonc)$/i.test(path)) return json();
  if (/\.(css|scss|less)$/i.test(path)) return css();
  if (/\.(html?|vue|svelte)$/i.test(path)) return html();
  if (/\.(xml|svg|xsd|xsl)$/i.test(path)) return xml();
  if (/\.(md|markdown)$/i.test(path)) return markdown();
  return [];
}
const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: '#c69cdd' },
  { tag: [tags.string, tags.attributeValue], color: '#a2c48a' },
  { tag: [tags.number, tags.bool, tags.null], color: '#d3ab79' },
  { tag: [tags.comment], color: '#8c929d', fontStyle: 'italic' },
  { tag: [tags.tagName, tags.typeName, tags.className], color: '#8cb8e7' },
  { tag: [tags.attributeName, tags.propertyName], color: '#c7afdf' },
  { tag: [tags.function(tags.variableName)], color: '#e0c28a' },
]);
const theme = EditorView.theme({
  '&': { height: '100%', color: '#dce0e6', backgroundColor: '#202226', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto', lineHeight: '1.75' },
  '.cm-content': { padding: '8px 0', caretColor: '#dce0e6' },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters': { backgroundColor: '#202226', color: '#7f8898', borderRight: '1px solid #31343b' },
  '.cm-activeLineGutter': { backgroundColor: '#292f39', color: '#becae0' },
  '.cm-activeLine': { backgroundColor: '#7182a00a' },
  '.cm-cursor': { borderLeftColor: '#e0e5ed' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#365273 !important' },
  '.cm-selectionMatch': { backgroundColor: '#53603e55' },
  '&.cm-focused': { outline: 'none' },
  '.cm-panels': { backgroundColor: '#272a30', color: '#dce0e6' },
  '.cm-search input': { backgroundColor: '#202226', color: '#dce0e6', border: '1px solid #626a79', borderRadius: '3px' },
  '.cm-search button': { background: '#333841', color: '#dce0e6', border: '1px solid #626a79', borderRadius: '3px' },
  '.cm-searchMatch': { backgroundColor: '#705c3080', outline: '1px solid #aa8b49' },
  '.cm-searchMatch-selected': { backgroundColor: '#8b713b' },
}, { dark: true });

export default function InlineEditor({ repoId, path, revision, loadFile, saveFile, onSaved, onDraftsChange, busy = false, patch = '', loading = false }) {
  const key = draftKey(repoId, path), entry = drafts.get(key);
  const host = useRef(null), view = useRef(null), editable = useRef(null), callbacks = useRef({});
  const activeKey = useRef(key), saving = useRef(false), saveCurrent = useRef(null);
  const [split, setSplit] = useState(false), [version, setVersion] = useState(0), [, render] = useState(0);
  const [error, setError] = useState(''), [reading, setReading] = useState(false), [isSaving, setSaving] = useState(false);
  callbacks.current = { loadFile, saveFile, onSaved, onDraftsChange, busy, repoId };
  activeKey.current = key;
  const repaint = () => render(value => value + 1);
  const notifyDrafts = () => { syncDraftGuard(); callbacks.current.onDraftsChange?.(dirtyEditorPaths(callbacks.current.repoId)); };

  useEffect(() => {
    let cancelled = false;
    setError(''); notifyDrafts();
    if (!path || !repoId) { setReading(false); return; }
    setReading(!drafts.has(key));
    callbacks.current.loadFile(path).then(data => {
      if (cancelled) return;
      const existing = drafts.get(key);
      if (!existing) {
        compactCleanDrafts();
        drafts.set(key, { repoId, path, base: data, original: normalize(data.original || ''), content: normalize(data.content), disk: null });
        setVersion(value => value + 1);
      } else {
        const changedBase = existing.original !== normalize(data.original || '');
        existing.original = normalize(data.original || '');
        if (data.token !== existing.base.token) {
          if (dirty(existing) && existing.base.content === data.content) { existing.base = data; existing.disk = null; }
          else if (dirty(existing) && existing.content !== normalize(data.content)) existing.disk = data;
          else {
            existing.base = data; existing.content = normalize(data.content); existing.disk = null;
            existing.history = null; existing.selection = null;
            setVersion(value => value + 1);
          }
        }
        if (changedBase) setVersion(value => value + 1);
      }
      notifyDrafts(); repaint();
    }).catch(reason => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [repoId, path, revision]);

  useEffect(() => {
    const current = drafts.get(key);
    if (!host.current || !current || !path) return;
    const compartment = new Compartment(); editable.current = compartment;
    const readonly = value => [EditorState.readOnly.of(value), EditorView.editable.of(!value)];
    const shared = [lineNumbers(), drawSelection(), bracketMatching(), indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), syntaxHighlighting(colors), language(path), theme];
    const localExtensions = [...shared, history(), ...(current.history ? [historyField.init(() => current.history)] : []), highlightActiveLine(), highlightSelectionMatches(),
      compartment.of(readonly(callbacks.current.busy || saving.current)),
      EditorView.contentAttributes.of({ 'aria-label': `编辑 ${path}`, 'aria-describedby': 'inline-editor-help', spellcheck: 'false' }),
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { saveCurrent.current?.(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          const wasDirty = dirty(current);
          current.content = update.state.doc.toString();
          if (dirty(current) !== wasDirty) notifyDrafts();
          repaint();
        }
      }),
    ];
    const localConfig = { doc: current.content, selection: current.selection || undefined, extensions: localExtensions };
    let instance, local;
    if (split) {
      instance = new MergeView({
        a: { doc: current.original, extensions: [...shared, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': `${path} 的提交前版本` })] },
        b: localConfig, parent: host.current, gutter: true, highlightChanges: true, diffConfig: { scanLimit: 1000, timeout: 80 },
      });
      local = instance.b;
    } else {
      localConfig.extensions.push(unifiedMergeView({ original: current.original, mergeControls: false, gutter: true, highlightChanges: true, diffConfig: { scanLimit: 1000, timeout: 80 } }));
      instance = local = new EditorView({ ...localConfig, parent: host.current });
    }
    view.current = local;
    if (current.scrollTop) local.scrollDOM.scrollTop = current.scrollTop;
    if (current.scrollLeft) local.scrollDOM.scrollLeft = current.scrollLeft;
    repaint();
    return () => {
      // A disk reload may already have replaced content. Do not attach the old
      // document's undo state or selection to that replacement.
      if (local.state.doc.toString() === current.content) {
        current.history = local.state.field(historyField, false);
        current.selection = local.state.selection;
      }
      current.scrollTop = local.scrollDOM.scrollTop; current.scrollLeft = local.scrollDOM.scrollLeft;
      instance.destroy();
      if (view.current === local) view.current = null;
    };
  }, [repoId, path, split, version]);

  useEffect(() => {
    if (view.current && editable.current) view.current.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(busy || isSaving), EditorView.editable.of(!busy && !isSaving)]) });
  }, [busy, isSaving, version]);

  async function save() {
    const current = drafts.get(key);
    if (!current || !dirty(current) || current.disk || saving.current || callbacks.current.busy) return;
    const content = current.content;
    saving.current = true; setSaving(true); setError('');
    try {
      const result = await callbacks.current.saveFile({ path, token: current.base.token, content });
      if (!result?.file) throw new Error('保存未完成，草稿已保留。');
      current.base = { ...current.base, ...result.file }; current.disk = null;
      if (current.content === content) current.content = normalize(result.file.content);
      callbacks.current.onSaved?.(result);
      notifyDrafts();
    } catch (reason) {
      if (activeKey.current === key) setError(reason.message);
      // A stale-token response never overwrites the draft; fetch the disk version for comparison.
      try {
        const disk = await callbacks.current.loadFile(path);
        if (disk.token !== current.base.token) current.disk = disk;
      } catch { /* Keep the original error and draft when disk is unavailable. */ }
    } finally {
      saving.current = false; setSaving(false); repaint();
    }
  }
  saveCurrent.current = save;

  function acceptDisk(keepDraft) {
    if (!entry?.disk || busy || isSaving) return;
    entry.base = entry.disk; entry.original = normalize(entry.disk.original || '');
    if (!keepDraft) { entry.content = normalize(entry.disk.content); entry.history = null; entry.selection = null; }
    entry.disk = null; setError(''); notifyDrafts(); setVersion(value => value + 1);
  }
  const writable = !!entry, isDirty = dirty(entry), editorState = view.current?.state;
  return <section className="diff-pane inline-editor" aria-label="文件差异与编辑">
    <header className="diff-heading inline-editor-heading">
      <div><strong>{path ? path.split('/').at(-1) : '改动预览'}{isDirty && <i className="editor-draft-mark" title="有未保存的修改">●</i>}</strong><span title={path}>{path || '选择一个文件查看差异并编辑'}</span></div>
      <div className="diff-tools">
        {writable && <>
          <button className="icon-button" aria-label="撤销编辑" title="撤销 · ⌘ / Ctrl + Z" disabled={busy || isSaving || !editorState || !undoDepth(editorState)} onClick={() => { if (view.current) { undo(view.current); view.current.focus(); } }}><Undo2 size={15}/></button>
          <button className="icon-button" aria-label="重做编辑" title="重做 · ⌘ / Ctrl + Shift + Z" disabled={busy || isSaving || !editorState || !redoDepth(editorState)} onClick={() => { if (view.current) { redo(view.current); view.current.focus(); } }}><Redo2 size={15}/></button>
          <button aria-label="保存文件" title="⌘ / Ctrl + S" className={isDirty ? 'primary' : ''} disabled={busy || isSaving || !isDirty || !!entry.disk} onClick={save}><Save size={14}/><span>{isSaving ? '保存中…' : '保存'}</span></button>
          <button className="icon-button" aria-label={split ? '切换统一差异' : '切换左右对比'} title={split ? '统一差异' : '左右对比'} onClick={() => setSplit(value => !value)}>{split ? <AlignLeft size={16}/> : <Columns2 size={16}/>}</button>
        </>}
      </div>
    </header>
    {error && <p className="inline-editor-error" role="alert">{error}</p>}
    {entry?.disk && <div className="inline-editor-disk">
      <p>磁盘内容已变化，当前草稿已保留。请核对磁盘版本后再保存。</p>
      <div><button disabled={busy || isSaving} onClick={() => acceptDisk(false)}>使用磁盘版本</button><button disabled={busy || isSaving} onClick={() => acceptDisk(true)}>已核对，保留草稿</button></div>
      <details><summary>查看磁盘版本</summary><pre>{entry.disk.content}</pre></details>
    </div>}
    {writable && split && <div className="inline-editor-side-labels"><span>提交前版本 · 只读</span><span>工作区 · 可编辑</span></div>}
    <div className={`inline-editor-body ${split ? 'is-split' : ''}`} ref={host} hidden={!writable}/>
    {!writable && (!path ? <div className="empty"><FileDiff size={30}/><p>点击文件查看改动</p><span>勾选本次提交的文件；在这里直接编辑</span></div> : reading || loading ? <div className="empty"><p>正在读取文件…</p></div> : <div className="inline-editor-fallback">{patch ? <pre>{patch}</pre> : <p>此文件没有可编辑的文本内容。</p>}</div>)}
    {writable && <div className="inline-editor-footer" id="inline-editor-help"><span>{isDirty ? '未保存的草稿' : '工作区文件'} · UTF-8{entry.base.crlf ? ' · CRLF' : ''}</span><span>⌘ / Ctrl + S 保存 · ⌘ / Ctrl + F 查找</span></div>}
  </section>;
}
