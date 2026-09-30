import React, { useState } from 'react';
import Dialog from './Dialog';
import Dropdown from './Dropdown';
export default function ExclusionDialog({ rules, error, busy, onChange, onClose }) {
  const [path, setPath] = useState(''), [type, setType] = useState('directory');
  return <Dialog busy={busy} onClose={onClose} aria-labelledby="exclusion-title">
    <h2 id="exclusion-title">永不提交规则</h2><p>仅保存在本机仓库。目录规则同时包含子目录和以后新增的文件。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <form onSubmit={async e => { e.preventDefault(); if (await onChange([...rules, { path: path.trim().replace(/\/$/, ''), type }])) setPath(''); }}>
      <div className="exclusion-add"><Dropdown label="规则类型" value={type} onChange={setType} options={[{ value: 'directory', label: '整个目录' }, { value: 'file', label: '单个文件' }]}/><input aria-label="永不提交相对路径" data-dialog-autofocus placeholder="例如 config/local" value={path} onChange={e => setPath(e.target.value)} disabled={busy}/><button disabled={busy || !path.trim()} type="submit">添加</button></div>
    </form>
    <div className="exclusion-rules">{rules.map((rule, index) => <div key={rule.type + rule.path}><span title={rule.path}>{rule.excluded === false ? '允许提交的例外' : rule.type === 'directory' ? '目录' : '文件'} · {rule.path}</span><button disabled={busy} onClick={() => onChange(rules.filter((_, i) => i !== index))}>移出</button></div>)}{!rules.length && <p>尚未添加规则，也可以在文件列表中多选后移入。</p>}</div>
    <div className="dialog-actions"><button onClick={onClose} disabled={busy}>完成</button></div>
  </Dialog>;
}
