import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './git.mjs';
import { validPath } from './exclusions.mjs';

const defaults = () => ({ groups: [{ id: 'changes', name: '更改' }], activeId: 'changes', assignments: Object.create(null), newFilePolicy: 'manual' });
const policies = ['manual', 'ask', 'auto'];
const virtualNames = ['永不提交', '未受版本控制'];
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\r\n\0]/.test(value)) throw new Error('分组名称须为 1–80 个字符');
  if (virtualNames.includes(value.trim())) throw new Error('该名称已用于系统分组');
  return value.trim();
}
async function location(root) { return join((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(), 'git-panel-changelists.json'); }
function normalize(value) {
  if (!value || !Array.isArray(value.groups) || value.groups.length > 100) throw new Error('分组数据格式无效');
  const seen = new Set(), names = new Set();
  const groups = value.groups.map(group => {
    if (!group || typeof group.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(group.id) || seen.has(group.id)) throw new Error('分组标识无效');
    const name = group.id === 'changes' ? '更改' : label(group.name);
    if (names.has(name)) throw new Error('分组名称重复');
    seen.add(group.id); names.add(name); return { id: group.id, name };
  });
  if (!seen.has('changes')) groups.unshift({ id: 'changes', name: '更改' });
  seen.add('changes');
  const assignments = Object.create(null), entries = Object.entries(value.assignments || {});
  if (entries.length > 50000) throw new Error('分组文件数量超过限制');
  for (const [path, id] of entries) if (validPath(path) && seen.has(id)) assignments[path] = id;
  return { groups, activeId: seen.has(value.activeId) ? value.activeId : 'changes', assignments, newFilePolicy: policies.includes(value.newFilePolicy) ? value.newFilePolicy : 'manual' };
}

// Reconcile in memory only. Snapshot reads never write metadata or trigger watcher loops.
export async function readChangelists(root, files) {
  let data;
  try { data = normalize(JSON.parse(await readFile(await location(root), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') data = defaults(); else throw new Error('更改分组无法读取：' + error.message); }
  if (Array.isArray(files)) {
    for (const file of files) if (file.oldPath && /R/.test(file.code) && Object.hasOwn(data.assignments, file.oldPath)) {
      if (!Object.hasOwn(data.assignments, file.path)) data.assignments[file.path] = data.assignments[file.oldPath];
      delete data.assignments[file.oldPath];
    }
  }
  return data;
}
async function persist(root, value) {
  const path = await location(root), temporary = path + '.' + randomUUID();
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function forgetChangelistPaths(root, paths) {
  const data = await readChangelists(root);
  let changed = false;
  for (const path of paths) if (Object.hasOwn(data.assignments, path)) { delete data.assignments[path]; changed = true; }
  if (changed) await persist(root, data);
}
export async function changelistAction(root, before, body) {
  const data = await readChangelists(root, before.files);
  const find = () => { const group = data.groups.find(item => item.id === body.groupId); if (!group) throw new Error('分组已不存在'); return group; };
  if (body.op === 'create') {
    const name = label(body.name);
    if (data.groups.some(group => group.name === name)) throw new Error('已存在同名分组');
    if (data.groups.length >= 100) throw new Error('最多创建 100 个更改分组');
    data.groups.push({ id: randomUUID(), name });
  } else if (body.op === 'rename') {
    const group = find(); if (group.id === 'changes') throw new Error('默认“更改”分组不能重命名');
    const name = label(body.name);
    if (data.groups.some(item => item.id !== group.id && item.name === name)) throw new Error('已存在同名分组');
    group.name = name;
  } else if (body.op === 'remove') {
    const group = find(); if (group.id === 'changes') throw new Error('默认“更改”分组不能移除');
    data.groups = data.groups.filter(item => item.id !== group.id);
    for (const path of Object.keys(data.assignments)) if (data.assignments[path] === group.id) data.assignments[path] = 'changes';
    // Existing unassigned changes belong to the active group; keep them in Changes on removal.
    if (data.activeId === group.id) { for (const file of before.files) if (file.code !== '??' && !Object.hasOwn(data.assignments, file.path)) data.assignments[file.path] = 'changes'; data.activeId = 'changes'; }
  } else if (body.op === 'set-active') {
    const group = find();
    for (const file of before.files) if (file.code !== '??' && !Object.hasOwn(data.assignments, file.path)) data.assignments[file.path] = data.activeId;
    data.activeId = group.id;
  } else if (body.op === 'move') {
    find();
    if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 2000 || body.paths.some(path => !validPath(path))) throw new Error('请选择需要移动的文件');
    const selected = [...new Set(body.paths)].map(path => before.files.find(file => file.path === path));
    if (selected.some(file => !file)) throw new Error('文件列表已变化，请重新选择');
    if (selected.some(file => file.excluded)) throw new Error('请先把文件移出永不提交，再移动到其他分组');
    for (const file of selected) { data.assignments[file.path] = body.groupId; if (file.oldPath && /R/.test(file.code)) delete data.assignments[file.oldPath]; }
  } else if (body.op === 'policy') {
    if (!policies.includes(body.newFilePolicy)) throw new Error('新文件处理方式无效');
    data.newFilePolicy = body.newFilePolicy;
  } else throw new Error('不支持的分组操作');
  await persist(root, normalize(data));
  return data;
}
