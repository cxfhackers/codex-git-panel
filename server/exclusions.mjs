import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './git.mjs';

export function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0') && !path.includes('\\') && !path.startsWith('/') && path.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
}
export function normalizeRules(rules) {
  if (!Array.isArray(rules) || rules.length > 2000) throw new Error('永不提交规则数量无效');
  const result = new Map();
  for (const rule of rules) {
    if (!rule || !validPath(rule.path) || !['file', 'directory'].includes(rule.type)) throw new Error('请输入仓库内的相对文件或目录路径');
    result.set(rule.type + ':' + rule.path, { type: rule.type, path: rule.path, ...(rule.excluded === false && rule.type === 'file' ? { excluded: false } : {}) });
  }
  return [...result.values()];
}
async function location(root) {
  const dir = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return join(dir, 'git-panel-exclusions.json');
}
export async function readRules(root) {
  try { return normalizeRules(JSON.parse(await readFile(await location(root), 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return []; throw new Error('永不提交规则无法读取：' + e.message); }
}
export function isExcluded(file, rules) {
  return [file.path, file.oldPath].filter(Boolean).some(path => {
    const exact = rules.find(rule => rule.type === 'file' && rule.path === path);
    if (exact) return exact.excluded !== false;
    return rules.some(rule => rule.type === 'directory' && (path === rule.path || path.startsWith(rule.path + '/')));
  });
}
async function persistRules(root, rules) {
  const file = await location(root), temporary = file + '.' + randomUUID();
  await writeFile(temporary, JSON.stringify(rules, null, 2), { mode: 0o600 }); await rename(temporary, file);
}
export async function unstageExcluded(root, before, rules) {
  const files = before.files.filter(f => f.staged && isExcluded(f, rules));
  const renamedPaths = files.filter(f => f.oldPath).flatMap(f => [f.path, f.oldPath]).filter(path => !isExcluded({ path }, rules));
  if (renamedPaths.length) { rules = normalizeRules([...rules, ...renamedPaths.map(path => ({ type: 'file', path }))]); await persistRules(root, rules); }
  const paths = [...new Set(files.flatMap(f => [f.path, ...(f.oldPath ? [f.oldPath] : [])]))];
  for (let i = 0; i < paths.length; i += 250) {
    await git(root, before.head ? ['restore', '--staged', '--', ...paths.slice(i, i + 250)] : ['rm', '--cached', '-f', '-r', '--', ...paths.slice(i, i + 250)]);
  }
}
export async function updateRules(root, before, body) {
  const rules = normalizeRules(body.rules);
  if (before.files.some(f => f.conflict && isExcluded(f, rules) && !isExcluded(f, before.exclusions))) throw new Error('请先解决该文件的冲突，再移入永不提交');
  // Persist protection first: even if unstaging fails, future staging/commit stays guarded.
  await persistRules(root, rules);
  await unstageExcluded(root, before, rules);
}
