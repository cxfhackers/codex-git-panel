import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, snapshot } from './git.mjs';

const filename = 'git-panel-local-changes.json';
async function directory(root) { return (await git(root, ['rev-parse', '--absolute-git-dir'])).trim(); }
async function persist(dir, value) {
  const temp = join(dir, filename + '.' + randomUUID());
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, join(dir, filename));
}
export async function localChangesStatus(root, dir) {
  let value;
  try { value = JSON.parse(await readFile(join(dir, filename), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('自动保存记录无法读取，请保留 Git stash 备份并检查仓库'); }
  if (!/^git-panel-auto-[a-f0-9-]+$/.test(value.label) || !value.headRef?.startsWith('refs/heads/')) throw new Error('自动保存记录格式不正确');
  if (!value.oid) {
    const list = await git(root, ['stash', 'list', '--format=%H%x00%gs']);
    value.oid = list.split('\n').map(row => row.split('\0')).find(([, label]) => label?.endsWith(value.label))?.[0] || '';
  }
  if (value.oid && !/^[a-f0-9]{40,64}$/.test(value.oid)) throw new Error('自动保存记录中的提交无效');
  return value;
}
async function pending(root) { const dir = await directory(root); return { dir, value: await localChangesStatus(root, dir) }; }
function restoreWarning(value) {
  return `更新或合并已结束，但本地改动尚未完整恢复。请处理恢复冲突或核对文件后完成恢复；原始备份保留在 Git stash（${value.label}），尚未推送。`;
}
export async function restoreLocalChanges(root, result = {}) {
  const { dir, value } = await pending(root);
  if (!value) return { ...result, state: await snapshot(root) };
  let state = await snapshot(root);
  if (state.operation && state.operation.type !== 'local-restore') return { ...result, state };
  if (value.phase === 'restored') {
    await rm(join(dir, filename));
    return { ...result, state: await snapshot(root) };
  }
  if (state.headRef !== value.headRef || !value.oid || !['saved', 'preparing'].includes(value.phase)) {
    return { ...result, state, status: 'restore-conflict', warning: restoreWarning(value), pushed: false };
  }
  value.phase = 'restoring'; await persist(dir, value);
  try {
    await git(root, ['stash', 'apply', '--index', value.oid], { literalPathspecs: false });
    value.phase = 'restored'; await persist(dir, value);
    await rm(join(dir, filename));
    return { ...result, state: await snapshot(root), output: [result.output, '本地改动已恢复，暂存状态已保留；自动备份保留在 Git stash。'].filter(Boolean).join('\n') };
  } catch (e) {
    value.phase = 'restore-conflict'; await persist(dir, value);
    return { ...result, state: await snapshot(root), status: 'restore-conflict', warning: restoreWarning(value), output: [result.output, e.message].filter(Boolean).join('\n'), pushed: false };
  }
}
export async function withLocalChanges(root, before, operation) {
  if ((await snapshot(root)).revision !== before.revision) throw new Error('仓库内容已变化，请刷新后重新核对');
  if (!before.files.length) return operation();
  if (before.operation || before.files.some(f => f.conflict)) throw new Error('请先处理当前操作的冲突');
  const { dir, value: existing } = await pending(root);
  if (existing) throw new Error('请先完成本地改动恢复');
  const id = randomUUID(), label = 'git-panel-auto-' + id;
  const value = { label, oid: '', backupRef: 'refs/git-panel/local-backups/' + id, headRef: before.headRef, phase: 'preparing', files: before.files.map(f => f.path), createdAt: new Date().toISOString() };
  // The intent is durable before stash changes the worktree. Restart recovery finds our unique label.
  await writeFile(join(dir, filename), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try {
    await git(root, ['stash', 'push', '--include-untracked', '-m', label], { literalPathspecs: false });
    const found = await localChangesStatus(root, dir);
    if (!found.oid) throw new Error('自动保存未生成备份，更新没有执行');
    value.oid = found.oid; value.phase = 'saved'; await persist(dir, value);
    await git(root, ['update-ref', value.backupRef, value.oid]);
    const clean = await snapshot(root);
    if (clean.head !== before.head || clean.headRef !== before.headRef || clean.files.length) throw new Error('自动保存后仓库仍有改动或分支发生变化，更新没有执行；请核对备份和工作区');
  } catch (e) {
    const saved = await localChangesStatus(root, dir);
    if (!saved.oid) { await rm(join(dir, filename)); throw e; }
    const result = await restoreLocalChanges(root, { status: 'error', output: e.message });
    if (result.status === 'restore-conflict') return result;
    throw e;
  }
  try {
    const result = await operation();
    if (['merge', 'rebase'].includes(result.state?.operation?.type)) return result;
    return restoreLocalChanges(root, result);
  } catch (e) {
    const result = await restoreLocalChanges(root, { status: 'error', output: e.message });
    if (result.status === 'restore-conflict') return result;
    throw e;
  }
}
export async function recoveryAction(root, action, before) {
  const { dir, value } = await pending(root);
  if (!value || before.operation?.type !== 'local-restore') throw new Error('当前没有待恢复的本地改动，请刷新');
  if (before.headRef !== value.headRef) throw new Error('当前分支已变化，请回到原分支后核对恢复');
  if (action === 'restore-retry') {
    if (before.files.length || !['saved', 'preparing'].includes(value.phase)) throw new Error('恢复已经开始或工作区有改动，请手动核对文件后完成恢复，避免重复应用备份');
    return restoreLocalChanges(root, { status: 'success', output: '已重新恢复自动保存的改动' });
  }
  if (before.files.some(f => f.conflict)) throw new Error('请先解决恢复冲突并标记已解决');
  // Explicit UI confirmation: retain every worktree file, make all resolutions uncommitted.
  await git(root, ['reset', '--mixed', '--quiet', 'HEAD']);
  await rm(join(dir, filename));
  return { state: await snapshot(root), status: 'success', output: '已结束恢复；当前文件均保留为未暂存改动，原始自动备份仍在 Git stash 中。' };
}
