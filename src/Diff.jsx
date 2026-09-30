import { FileDiff, Columns2, AlignLeft } from 'lucide-react';
import React, { useState, useMemo } from 'react';
function linesFor(patch) {
  let old = 0, next = 0, hunk = -1;
  return patch.split('\n').filter((line, i, arr) => i < arr.length - 1 || line).map(line => {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { old = Number(m[1]); next = Number(m[2]); hunk++; return { line, type: 'hunk', hunk }; }
    if (hunk < 0 || line.startsWith('\\')) return { line, type: 'meta' };
    if (line[0] === '+') return { line, type: 'added', next: next++ };
    if (line[0] === '-') return { line, type: 'removed', old: old++ };
    return { line, type: 'context', old: old++, next: next++ };
  });
}
function paired(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].type === 'removed' || rows[i].type === 'added') {
      const left = [], right = [];
      while (i < rows.length && ['removed', 'added'].includes(rows[i].type)) { (rows[i].type === 'removed' ? left : right).push(rows[i++]); }
      for (let j = 0; j < Math.max(left.length, right.length); j++) out.push({ left: left[j], right: right[j] });
    } else { const row = rows[i++]; out.push(row.type === 'context' ? { left: row, right: row } : { meta: row }); }
  }
  return out;
}
export default function Diff({ path, patch, loading, staged, file, busy, onHunk }) {
  const [split, setSplit] = useState(false);
  const rows = useMemo(() => linesFor(patch), [patch]);
  const pairs = useMemo(() => paired(rows), [rows]);
  const allowHunk = file && file.kind === 'M' && file.code !== '??' && !file.oldPath && !file.conflict;
  const renderMeta = (r, key) => <div key={key} className={`diff-meta ${r.type}`}><code>{r.line}</code>{r.type === 'hunk' && allowHunk && <button disabled={busy} onClick={() => onHunk(r.hunk)}>{staged ? '取消暂存代码块' : '暂存代码块'}</button>}</div>;
  return <section className="diff-pane" aria-label="代码差异">
    <header className="diff-heading"><div><strong>{path ? path.split('/').at(-1) : '改动预览'}</strong><span>{path || '选择一个文件查看差异'}</span></div><button className="icon-button" aria-label={split ? '切换统一差异' : '切换左右对比'} title={split ? '统一差异' : '左右对比'} onClick={() => setSplit(!split)}>{split ? <AlignLeft size={18}/> : <Columns2 size={18}/>}</button></header>
    <div className="diff-scroll">{!path ? <div className="empty"><FileDiff size={32}/><p>点击文件查看改动</p><span>点击文件行可多选；勾选立即暂存</span></div> : loading ? <div className="empty"><FileDiff size={28}/><p>正在读取差异…</p></div> : !patch ? <div className="empty"><FileDiff size={28}/><p>此视图下没有文本差异</p><span>可能是文件属性或子模块变更</span></div> : split ? <div className="split-diff">{pairs.map((r, i) => r.meta ? renderMeta(r.meta, i) : <div className="split-row" key={i}>{[r.left, r.right].map((side, n) => <div key={n} className={`split-cell ${side?.type || 'blank'}`}><span className="number">{n === 0 ? side?.old : side?.next}</span><code>{side?.line.slice(1) || ' '}</code></div>)}</div>)}</div> : <div className="unified-diff">{rows.map((r, i) => ['meta', 'hunk'].includes(r.type) ? renderMeta(r, i) : <div className={`diff-row ${r.type}`} key={i}><span className="number">{r.old}</span><span className="number">{r.next}</span><code>{r.line}</code></div>)}</div>}</div>
  </section>;
}
