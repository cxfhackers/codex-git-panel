import React, { useEffect, useState, useRef } from 'react';
import Dialog from './Dialog';
import { request } from './api';
export default function FileEditor({ id, path, revision, busy, onSave, onClose }) {
  const input = useRef(null);
  const [base, setBase] = useState(null), [text, setText] = useState(''), [error, setError] = useState('');
  const [disk, setDisk] = useState(null), [discard, setDiscard] = useState(false);
  const dirty = base && text !== base.content.replace(/\r\n/g, '\n');
  useEffect(() => {
    let cancelled = false;
    request(`/api/file?id=${id}`, { path }).then(data => { if (!cancelled) { setBase(data); setText(data.content.replace(/\r\n/g, '\n')); } }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [id, path]);
  useEffect(() => { if (base) input.current?.focus(); }, [!!base]);
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    request(`/api/file?id=${id}`, { path }).then(data => { if (!cancelled) setDisk(data.token === base.token ? null : data); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [revision, base?.token]);
  useEffect(() => {
    if (!dirty) return;
    const handler = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  async function save() {
    if (!base || busy || !dirty || disk) return;
    setError('');
    const result = await onSave({ path, token: base.token, content: text });
    if (result?.file) { setBase(result.file); setText(result.file.content.replace(/\r\n/g, '\n')); setDisk(null); }
    else { setError('保存未完成，草稿已保留。请检查提示或重新读取磁盘版本。'); }
  }
  async function reload() {
    try { const data = await request(`/api/file?id=${id}`, { path }); setDisk(data); setError(''); } catch (e) { setError(e.message); }
  }
  return <Dialog className="file-editor" busy={busy || !!dirty} onClose={onClose} aria-labelledby="editor-title" onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } }}>
    <h2 id="editor-title">编辑文件 {dirty && <small>· 未保存</small>}</h2><p className="editor-path">{path}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {disk && <div className="editor-disk"><p>磁盘内容已变化。当前草稿保留在下方，可对照磁盘版本后复制合并。</p><details><summary>查看磁盘版本</summary><pre>{disk.content}</pre></details><button disabled={busy} onClick={() => { setBase(disk); setText(disk.content.replace(/\r\n/g, '\n')); setDisk(null); setDiscard(false); }}>放弃草稿，使用磁盘版本</button><button disabled={busy} onClick={() => { setBase(disk); setDisk(null); setError('已以新磁盘版本为基础，请核对合并后的草稿再保存'); }}>保留草稿，已核对磁盘版本</button></div>}
    <textarea ref={input} aria-label="文件内容" data-dialog-autofocus spellCheck={false} disabled={!base || busy} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); const element = e.currentTarget, start = element.selectionStart, end = element.selectionEnd; setText(text.slice(0, start) + '  ' + text.slice(end)); requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = start + 2; }); } }}/>
    <div className="editor-hint">UTF-8 · 保存到工作区 · ⌘ / Ctrl + S 保存</div>
    {discard && <p className="form-error">有尚未保存的修改。<button onClick={onClose}>放弃草稿并关闭</button><button onClick={() => setDiscard(false)}>继续编辑</button></p>}
    <div className="dialog-actions"><button disabled={busy} onClick={reload}>读取磁盘版本</button><button disabled={busy} onClick={() => dirty ? setDiscard(true) : onClose()}>关闭</button><button className="primary" disabled={busy || !dirty || !!disk} onClick={save}>保存</button></div>
  </Dialog>;
}
