import { git, snapshot } from './git.mjs';
import { withLocalChanges, restoreLocalChanges } from './local-changes.mjs';

export async function listBranches(root, state) {
  const [raw, remotesText] = await Promise.all([
    git(root, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(symref)%00%(worktreepath)%00', 'refs/heads/', 'refs/remotes/']),
    git(root, ['remote']),
  ]);
  const remotes = remotesText.trim().split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
  const cells = raw.split('\0'), branches = [];
  for (let i = 0; i + 3 < cells.length; i += 4) {
    const ref = cells[i].replace(/^\n/, ''), oid = cells[i + 1], symref = cells[i + 2], worktree = cells[i + 3];
    if (symref || !/^[a-f0-9]{40,64}$/.test(oid)) continue;
    const type = ref.startsWith('refs/heads/') ? 'local' : 'remote';
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    const remote = type === 'remote' ? remotes.find(r => name.startsWith(r + '/')) : '';
    branches.push({ ref, oid, name, type, current: ref === state.headRef, worktree,
      localName: remote ? name.slice(remote.length + 1) : '', remote: remote || '' });
  }
  return branches;
}
export async function branchList(root) {
  const state = await snapshot(root);
  return { state, branches: await listBranches(root, state) };
}
async function targetBranch(root, before, body) {
  const branches = await listBranches(root, before);
  const target = branches.find(b => b.ref === body.ref);
  if (!target) throw new Error('分支不存在或已删除，请刷新分支列表');
  if (target.oid !== body.targetOid) throw new Error('目标分支已变化，请刷新并重新确认');
  return { target, branches };
}
async function unchanged(root, revision) {
  if ((await snapshot(root)).revision !== revision) throw new Error('仓库内容已变化，请刷新后重新核对');
}
export async function mergePreview(root, body) {
  const state = await snapshot(root);
  if (state.revision !== body.revision) throw new Error('仓库内容已变化，请刷新后重新核对');
  if (!state.head || !state.headRef) throw new Error('请先完成首次提交并切换到本地分支');
  const { target } = await targetBranch(root, state, body);
  const counts = (await git(root, ['rev-list', '--left-right', '--count', `${state.head}...${target.oid}`])).trim().split(/\s+/).map(Number);
  const raw = await git(root, ['log', '--max-count=20', '--format=%h%x00%s', `${state.head}..${target.oid}`]);
  const commits = raw.trim().split('\n').filter(Boolean).map(row => { const [sha, subject] = row.split('\0'); return { sha, subject }; });
  await unchanged(root, state.revision);
  return { state, target, currentOnly: counts[0], incoming: counts[1], commits };
}
export async function branchAction(root, action, body, before) {
  if (['merge-abort', 'merge-continue', 'rebase-abort', 'rebase-continue'].includes(action)) {
    const rebase = action.startsWith('rebase');
    const operationLabel = rebase ? '变基' : '合并';
    if (before.operation?.type !== (rebase ? 'rebase' : 'merge')) throw new Error(`当前没有进行中的${operationLabel}，请刷新`);
    if (action.endsWith('continue') && (before.files.some(f => f.conflict) || rebase && before.files.some(f => f.unstaged))) {
      throw new Error(`请先在面板或编辑器解决冲突并暂存相关修改，再继续${operationLabel}`);
    }
    await unchanged(root, body.revision);
    let output; try { output = await git(root, rebase ? ['-c', 'core.editor=true', 'rebase', action.endsWith('abort') ? '--abort' : '--continue'] : action === 'merge-abort' ? ['merge', '--abort'] : ['commit', '--no-edit']); } catch (error) { const state = await snapshot(root); if (rebase && state.operation?.type === 'rebase') return { state, status: 'conflict', warning: '变基仍有待解决的冲突，请继续处理或中止变基', output: error.message }; throw error; }
    return restoreLocalChanges(root, { state: await snapshot(root), output: output || (action.endsWith('abort') ? `已中止${operationLabel}` : `${operationLabel}已完成`), status: 'success' });
  }
  if (before.operation || before.files.some(f => f.conflict)) throw new Error('请先完成或中止当前 Git 操作，再切换或合并分支');
  const { target, branches } = await targetBranch(root, before, body);
  if (target.current) throw new Error('目标是当前分支，请选择其他分支');
  if (action === 'switch') {
    let args;
    if (target.type === 'local') {
      if (target.worktree && target.worktree !== root) throw new Error('此分支已在其他 worktree 中使用，请打开该 worktree');
      await git(root, ['check-ref-format', '--branch', target.name]);
      args = ['switch', '--no-guess', '--no-recurse-submodules', '--', target.name];
    } else {
      if (!target.localName) throw new Error('远程配置不存在；请先在终端配置远程');
      if (branches.some(b => b.type === 'local' && b.name === target.localName)) throw new Error('已有同名本地分支，请在列表中选择该本地分支');
      await git(root, ['check-ref-format', '--branch', target.localName]);
      args = ['switch', '--no-recurse-submodules', '--track', '-c', target.localName, '--', target.ref];
    }
    await unchanged(root, body.revision);
    await git(root, args);
    const state = await snapshot(root);
    return { state, status: 'success', output: `已切换到 ${state.branch}${state.files.length ? '；本地改动已保留' : ''}` };
  }
  if (!before.headRef || !before.head) throw new Error('请先完成首次提交并切换到本地分支，再合并');
  await unchanged(root, body.revision);
  return mergeIntoCurrent(root, target, before);
}
export async function mergeIntoCurrent(root, target, before) {
  return withLocalChanges(root, before, () => mergeRaw(root, target, before));
}
async function mergeRaw(root, target, before) {
  try {
    const output = await git(root, ['merge', '--ff', '--commit', '--no-edit', '--no-autostash', '--no-overwrite-ignore', '--no-rerere-autoupdate', '--no-allow-unrelated-histories', '-m', `Merge ${target.name} into ${before.branch}`, '--', target.oid]);
    return { state: await snapshot(root), status: 'success', output: output || '合并已完成' };
  } catch (error) {
    const state = await snapshot(root);
    if (state.operation?.type === 'merge') {
      const conflicts = state.files.filter(f => f.conflict);
      return { state, status: conflicts.length ? 'conflict' : 'merge-pending',
        warning: conflicts.length ? `合并遇到 ${conflicts.length} 个冲突文件。请在面板打开冲突文件，核对智能合并结果并暂存，再继续合并；也可中止合并。` : '合并尚未完成，请查看 Git 输出并处理后继续合并，或中止合并。',
        output: [error.stdout, error.stderr].filter(Boolean).join('\n') || error.message };
    }
    if (/would be overwritten|Your local changes|Please commit your changes or stash/i.test(error.message)) {
      throw new Error('Git 拒绝合并：部分本地改动影响本次合并。未提交的内容仍保留；可取消暂存，或仅临时保存提示中的冲突文件后重试，无需提交它们。\n' + error.message);
    }
    throw error;
  }
}
