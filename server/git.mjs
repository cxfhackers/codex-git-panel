import { readChangelists, changelistAction } from './changelists.mjs';
import { selectedCommit, generateSelectedMessage } from './selected-commit.mjs';
import { createShelf, restoreShelf } from './shelves.mjs';
import { readRules, isExcluded, updateRules, unstageExcluded } from './exclusions.mjs';
import { saveEditable } from './editor.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { realpath, lstat, readlink, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { localChangesStatus } from './local-changes.mjs';
const execute = promisify(execFile);
export async function git(root, args, options = {}) {
  const { literalPathspecs = true, ...executionOptions } = options;
  try {
    const r = await execute('git', [...(literalPathspecs ? ['--literal-pathspecs'] : []), '-C', root, ...args], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, ...executionOptions,
    });
    return r.stdout;
  } catch (e) {
    const error = new Error((e.stderr || e.stdout || e.message).trim());
    error.stdout = e.stdout || ''; error.stderr = e.stderr || ''; error.code = e.code;
    throw error;
  }
}
async function operationStatus(root) {
  const dir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const localBackup = await localChangesStatus(root, dir);
  const markers = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['sequencer', 'sequence']];
  for (const [marker, type] of markers) {
    try { await access(join(dir, marker)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (type === 'merge') {
      const heads = (await readFile(join(dir, marker), 'utf8')).trim().split('\n');
      const message = await readFile(join(dir, 'MERGE_MSG'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
      return { type, heads, message, ...(localBackup ? { localBackup } : {}) };
    }
    return { type, ...(localBackup ? { localBackup } : {}) };
  }
  return localBackup ? { type: 'local-restore', localBackup } : null;
}
export async function repository(input) {
  if (typeof input !== 'string' || !input.startsWith('/')) throw new Error('请输入仓库的绝对路径');
  const root = await realpath(input);
  return (await git(root, ['rev-parse', '--show-toplevel'])).trim();
}
export function parseStatus(raw) {
  const fields = raw.split('\0'); const files = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const code = fields[i].slice(0, 2); const path = fields[i].slice(3);
    let oldPath;
    if (/[RC]/.test(code)) oldPath = fields[++i];
    const untracked = code === '??';
    const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
    files.push({ path, oldPath, code, conflict,
      staged: !untracked && !conflict && code[0] !== ' ',
      unstaged: conflict || untracked || code[1] !== ' ',
      kind: conflict ? 'U' : untracked ? '?' : code.replaceAll(' ', '')[0],
    });
  }
  return files;
}
export async function snapshot(root) {
  // Independent reads run together; retain full content hashing for every write guard.
  const [status, headText, cached, work, refText, upstreamText, operation, countsText] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached']),
    git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary']),
    git(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => ''),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
    operationStatus(root),
    git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).catch(() => ''),
  ]);
  const exclusions = await readRules(root);
  const files = parseStatus(status).map(file => ({ ...file, excluded: isExcluded(file, exclusions) }));
  const changelists = await readChangelists(root, files);
  const head = headText.trim();
  const hash = createHash('sha256').update(head).update(status).update(cached).update(work);
  let untrackedBytes = 0;
  for (const f of files.filter(f => f.code === '??')) {
    try {
      const path = `${root}/${f.path}`, s = await lstat(path);
      hash.update(`${f.path}\0${s.mode & 0o111}\0`);
      if (s.isSymbolicLink()) hash.update(await readlink(path));
      else if (s.isFile()) {
        // Hash Git-relevant content; macOS may change ctime for unrelated metadata.
        for await (const chunk of createReadStream(path)) {
          untrackedBytes += chunk.length;
          if (untrackedBytes > 32 * 1024 * 1024) throw new Error('未跟踪文件总量超过 32 MiB，请先配置 .gitignore 或在其他工具暂存大文件');
          hash.update(chunk);
        }
      } else hash.update(`${s.size}:${s.mtimeMs}`);
      hash.update('\0');
    } catch (error) { if (error.code === 'ENOENT') hash.update('missing'); else throw error; }
  }
  const headRef = refText.trim();
  const branch = headRef ? headRef.replace(/^refs\/heads\//, '') : 'detached HEAD';
  const upstream = upstreamText.trim();
  hash.update(headRef).update(JSON.stringify(operation)).update(JSON.stringify(exclusions)).update(JSON.stringify(changelists));
  let sync = null;
  if (head && upstream && countsText.trim()) {
    const counts = countsText.trim().split(/\s+/).map(Number); sync = { ahead: counts[0], behind: counts[1], name: upstream };
  }
  return { root, branch, headRef, upstream, head, operation, sync, revision: hash.digest('hex'), files, exclusions, changelists };
}
export async function diff(root, path, staged) {
  // A read-only preview needs path validation, not hashes of every unrelated file.
  const file = parseStatus(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).find(f => f.path === path);
  if (!file) throw new Error('文件已变化，请刷新列表');
  if (file.code === '??') {
    try {
      return await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path]);
    } catch (e) {
      // git diff --no-index returns 1 for a difference; reuse the captured output.
      if (e.code === 1 && e.stdout) return e.stdout;
      throw e;
    }
  }
  return git(root, ['diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', path]);
}
export function splitHunks(patch) {
  const lines = patch.split('\n'); const first = lines.findIndex(l => l.startsWith('@@ '));
  if (first < 0 || lines.filter(l => l.startsWith('diff --git ')).length !== 1) return { header: '', hunks: [] };
  const header = lines.slice(0, first).join('\n') + '\n'; const hunks = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@ ')) hunks.push([]);
    hunks.at(-1).push(line);
  }
  return { header, hunks: hunks.map(h => h.join('\n').replace(/\n*$/, '\n')) };
}
async function applyPatch(root, patch, reverse) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', '-C', root, 'apply', '--cached', ...(reverse ? ['--reverse'] : []), '--'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let error = ''; const timer = setTimeout(() => child.kill(), 15000);
    child.stderr.on('data', b => { error += b; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error || '代码块暂存失败，请刷新')); });
    child.stdin.on('error', () => {}); child.stdin.end(patch);
  });
}
export async function mutate(root, action, body) {
  if (action === 'file-save') {
    const file = await saveEditable(root, body);
    try { return { file, state: await snapshot(root) }; }
    catch (error) { return { file, warning: '文件已保存；Git 状态暂未同步：' + error.message }; }
  }
  let before = await snapshot(root);
  if (before.revision !== body.revision) throw new Error('仓库内容已变化，请刷新后重新核对');
  if (action === 'changelist') { await changelistAction(root, before, body); return { state: await snapshot(root) }; }
  if (action === 'commit-selected') return selectedCommit(root, before, body);
  if (action === 'generate-selected') return generateSelectedMessage(root, before, body);
  if (action === 'shelf-create' || action === 'shelf-restore') {
    if (body.groupId && !before.changelists.groups.some(g => g.id === body.groupId)) throw new Error('目标分组已变化，请重新选择');
    const result = await (action === 'shelf-create' ? createShelf : restoreShelf)(root, before, body);
    let next = await snapshot(root);
    if (action === 'shelf-restore' && result.status !== 'conflict' && body.groupId) {
      const affected = new Set(result.affectedPaths || result.paths || []);
      const paths = next.files.filter(f => !f.excluded && !f.conflict && (affected.has(f.path) || affected.has(f.oldPath))).map(f => f.path);
      if (paths.length) {
        try {
          const untracked = next.files.filter(f => paths.includes(f.path) && f.code === '??').map(f => f.path);
          if (untracked.length) { await git(root, ['add', '-A', '--', ...untracked]); next = await snapshot(root); }
          await changelistAction(root, next, { op: 'move', groupId: body.groupId, paths }); next = await snapshot(root);
        }
        catch (error) { result.warning = '文件已恢复，分组整理暂未完成：' + error.message; }
      }
    }
    return { ...result, state: next };
  }
  if (action === 'exclusions') { await updateRules(root, before, body); return { state: await snapshot(root) }; }
  const protectedFile = before.files.find(f => f.path === body.path && f.excluded);
  if (protectedFile && (['stage', 'resolve', 'conflict-apply'].includes(action) || action === 'hunk' && !body.staged)) throw new Error('此文件属于永不提交，请先移出该分组');
  if (['merge-continue', 'rebase-continue'].includes(action) && before.files.some(f => f.excluded && f.staged)) throw new Error('暂存区含有永不提交文件，请先核对分组规则再继续');
  if (['conflict-ai', 'conflict-apply'].includes(action)) {
    const { suggestConflict, applyConflict } = await import('./conflicts.mjs');
    return action === 'conflict-ai' ? suggestConflict(root, before, body) : applyConflict(root, before, body);
  }
  if (action === 'set-staging') {
    if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 500 || typeof body.staged !== 'boolean' || body.paths.some(p => typeof p !== 'string' || !p)) throw new Error('暂存文件列表无效');
    const selected = [...new Set(body.paths)].map(path => before.files.find(f => f.path === path));
    if (selected.some(f => !f || f.conflict)) throw new Error('文件已变化或仍有冲突，请刷新后核对');
    if (body.staged && selected.some(f => f.excluded)) throw new Error('所选文件包含永不提交文件');
    const paths = [...new Set(selected.flatMap(f => [f.path, ...(f.oldPath ? [f.oldPath] : [])]))];
    await git(root, body.staged ? ['add', '-A', '--', ...paths] : before.head ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '--', ...paths]);
    return { state: await snapshot(root) };
  }
  if (['restore-retry', 'restore-finish'].includes(action)) { const { recoveryAction } = await import('./local-changes.mjs'); return recoveryAction(root, action, before); }
  if (['switch', 'merge', 'merge-continue', 'merge-abort', 'rebase-continue', 'rebase-abort'].includes(action)) {
    const { branchAction } = await import('./branches.mjs');
    return branchAction(root, action, body, before);
  }
  if (['sync-check', 'sync-update', 'push'].includes(action)) {
    const { checkSync, executeSync } = await import('./sync.mjs');
    return action === 'sync-check' ? checkSync(root, body, before) : executeSync(root, action, body, before);
  }
  const file = before.files.find(f => f.path === body.path);
  if (['stage', 'unstage', 'hunk', 'resolve'].includes(action) && !file) throw new Error('文件不在当前更改列表中');
  if (file?.conflict && action !== 'resolve' || before.files.some(f => f.conflict) && action === 'commit') throw new Error('请先解决合并冲突');
  if (action === 'resolve') {
    if (!file.conflict) throw new Error('文件已经不在冲突列表中，请刷新');
    try { await git(root, ['diff', '--check', '--', body.path]); }
    catch (error) {
      if (/leftover conflict marker/.test(error.stdout + error.stderr)) throw new Error('文件仍有冲突标记，请在编辑器解决后再标记已解决');
      if (![1, 2].includes(error.code)) throw error;
    }
    if ((await snapshot(root)).revision !== body.revision) throw new Error('文件已变化，请刷新后重新核对');
    await git(root, ['add', '-A', '--', body.path]);
  } else if (action === 'stage') {
    await git(root, ['add', '-A', '--', body.path, ...(file.oldPath ? [file.oldPath] : [])]);
  } else if (action === 'unstage') {
    const paths = [body.path, ...(file.oldPath ? [file.oldPath] : [])];
    await git(root, before.head ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '--', ...paths]);
  } else if (action === 'hunk') {
    if (file.code === '??' || file.kind !== 'M' || file.oldPath) throw new Error('此文件请按整个文件暂存');
    const patch = await diff(root, body.path, Boolean(body.staged));
    const { header, hunks } = splitHunks(patch);
    if (!Number.isInteger(body.hunk) || !hunks[body.hunk]) throw new Error('代码块已变化，请刷新');
    // Recheck after computing the patch, so a stale preview cannot be applied.
    if ((await snapshot(root)).revision !== body.revision) throw new Error('仓库内容已变化，请刷新');
    await applyPatch(root, header + hunks[body.hunk], Boolean(body.staged));
  } else if (action === 'generate') {
    const { generateMessage } = await import('./ai.mjs');
    return generateMessage(root, before);
  } else if (action === 'commit') {
    if (before.operation) throw new Error('仓库有未完成的 Git 操作；合并请使用“继续合并”，其他操作请先在终端完成');
    if (typeof body.message !== 'string' || !body.message.trim()) throw new Error('请填写提交信息');
    if (before.files.some(f => f.excluded && f.staged)) { await unstageExcluded(root, before, before.exclusions); before = await snapshot(root); }
    if (!before.files.some(f => f.staged)) throw new Error('没有已暂存的内容');
    const output = await git(root, ['commit', '-m', body.message.trim()]);
    return { state: await snapshot(root), output };
  } else throw new Error('不支持的操作');
  return { state: await snapshot(root) };
}
