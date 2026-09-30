import { randomBytes, createHash } from 'node:crypto';
import { git, snapshot } from './git.mjs';
import { mergeIntoCurrent } from './branches.mjs';
import { withLocalChanges } from './local-changes.mjs';

const previews = new Map();
const lines = value => value.trim().split('\n').filter(Boolean);
async function config(root, key) { return (await git(root, ['config', '--get', key]).catch(() => '')).trim(); }
function cleanError(error, url, remote) {
  return String(error.message || error).replaceAll(url, remote).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[hidden]@');
}
export async function syncTargets(root, state) {
  state ||= await snapshot(root);
  const remotes = lines(await git(root, ['remote']));
  const remote = state.headRef ? await config(root, `branch.${state.branch}.remote`) : '';
  const merge = state.headRef ? await config(root, `branch.${state.branch}.merge`) : '';
  return { remotes, remote: remotes.includes(remote) ? remote : remotes.includes('origin') ? 'origin' : remotes[0] || '', branch: merge.startsWith('refs/heads/') ? merge.slice(11) : state.headRef ? state.branch : '', setUpstream: !state.upstream };
}
async function destination(root, body, state) {
  if (!state.head || !state.headRef) throw new Error('请先完成首次提交并切换到本地分支');
  if (state.operation || state.files.some(f => f.conflict)) throw new Error('请先完成或中止当前 Git 操作');
  const remotes = lines(await git(root, ['remote']));
  if (!remotes.includes(body.remote)) throw new Error('请选择当前仓库已配置的远程');
  if (typeof body.branch !== 'string' || !body.branch || body.branch.startsWith('-')) throw new Error('请输入有效的远程分支名');
  const ref = `refs/heads/${body.branch}`;
  await git(root, ['check-ref-format', '--branch', body.branch]);
  await git(root, ['check-ref-format', ref]);
  const pushUrls = lines(await git(root, ['remote', 'get-url', '--push', '--all', body.remote]));
  if (pushUrls.length !== 1) throw new Error('该远程配置了多个推送地址，请先在 Git 配置中明确唯一推送地址');
  const url = pushUrls[0];
  const fetchUrl = (await git(root, ['remote', 'get-url', body.remote])).trim();
  const cacheRef = 'refs/git-panel/sync/' + createHash('sha256').update(url).update(ref).digest('hex');
  const strategy = body.strategy || 'merge';
  if (!['merge', 'rebase'].includes(strategy)) throw new Error('不支持的更新方式');
  return { remote: body.remote, branch: body.branch, name: `${body.remote}/${body.branch}`, ref, url, fetchUrl, cacheRef, strategy, setUpstream: Boolean(body.setUpstream) };
}
async function fetchDestination(root, target) {
  try {
    await git(root, ['fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--', target.url, `+${target.ref}:${target.cacheRef}`], { timeout: 45000 });
    const oid = (await git(root, ['rev-parse', '--verify', `${target.cacheRef}^{commit}`])).trim();
    await updateTracking(root, target, oid);
    return oid;
  } catch (error) {
    if (/couldn't find remote ref /.test(error.stderr || '') && (error.stderr || '').includes(target.ref)) return null;
    throw new Error(cleanError(error, target.url, target.remote));
  }
}
async function log(root, range) {
  const raw = await git(root, ['log', '--max-count=20', '--format=%h%x00%s', range]);
  return lines(raw).map(row => { const [sha, subject] = row.split('\0'); return { sha, subject }; });
}
async function storePreview(root, state, target, remoteOid) {
  const [ahead, behind] = remoteOid ? (await git(root, ['rev-list', '--left-right', '--count', `${state.head}...${remoteOid}`])).trim().split(/\s+/).map(Number) : [Number((await git(root, ['rev-list', '--count', state.head])).trim()), 0];
  const [outgoing, incoming] = await Promise.all([log(root, remoteOid ? `${remoteOid}..${state.head}` : state.head), remoteOid ? log(root, `${state.head}..${remoteOid}`) : []]);
  if ((await snapshot(root)).revision !== state.revision) throw new Error('检查期间仓库内容已变化，请刷新后重新检查');
  for (const [key, entry] of previews) if (entry.expires < Date.now()) previews.delete(key);
  if (previews.size >= 128) previews.delete(previews.keys().next().value);
  const previewToken = randomBytes(24).toString('hex');
  previews.set(previewToken, { root, revision: state.revision, target, remoteOid, expires: Date.now() + 600000 });
  return { state, previewToken, target: { remote: target.remote, branch: target.branch, name: target.name, strategy: target.strategy, setUpstream: target.setUpstream }, ahead, behind, outgoing, incoming, remoteExists: Boolean(remoteOid), checkedAt: new Date().toISOString() };
}
export async function checkSync(root, body, before) {
  const target = await destination(root, body, before), remoteOid = await fetchDestination(root, target);
  const current = await snapshot(root);
  if (current.revision !== before.revision) throw new Error('检查期间仓库内容已变化，请刷新后重新检查');
  return storePreview(root, current, target, remoteOid);
}
async function guard(root, revision) {
  if ((await snapshot(root)).revision !== revision) throw new Error('仓库内容已变化，请重新检查后再操作');
}
async function update(root, before, target, oid) {
  await guard(root, before.revision);
  try { await git(root, ['merge-base', before.head, oid]); } catch { throw new Error('本地与远程历史没有共同祖先，请检查推送目标；不会自动合并或变基'); }
  if (target.strategy === 'merge') return mergeIntoCurrent(root, { name: target.name, oid }, before);
  return withLocalChanges(root, before, async () => {
  try {
    const output = await git(root, ['rebase', '--no-autostash', '--no-rebase-merges', '--', oid]);
    return { state: await snapshot(root), status: 'success', output: output || '变基更新已完成' };
  } catch (error) {
    const state = await snapshot(root);
    if (state.operation?.type === 'rebase') return { state, status: 'conflict', warning: '变基更新已暂停。请解决冲突并暂存后继续变基，或中止本次变基；尚未推送。', output: cleanError(error, target.url, target.remote) };
    throw error;
  }
  });
}
async function updateTracking(root, target, head) {
  // Only update a conventional fetch-tracking ref when fetch and push use the same endpoint.
  if (target.url !== target.fetchUrl) return;
  const tracking = `refs/remotes/${target.remote}/${target.branch}`;
  const mappings = lines(await git(root, ['config', '--get-all', `remote.${target.remote}.fetch`]).catch(() => ''));
  if (mappings.includes(`+refs/heads/*:refs/remotes/${target.remote}/*`) || mappings.includes(`refs/heads/*:refs/remotes/${target.remote}/*`) || mappings.some(m => m.replace(/^\+/, '') === `${target.ref}:${tracking}`)) {
    await git(root, ['update-ref', '--no-deref', tracking, head]);
  }
}
export async function executeSync(root, action, body, before) {
  const approved = previews.get(body.previewToken);
  if (!approved || approved.root !== root || approved.expires < Date.now()) throw new Error('同步预览已失效，请重新检查');
  if (approved.revision !== before.revision) throw new Error('仓库内容已变化，请重新检查后再操作');
  previews.delete(body.previewToken);
  const target = await destination(root, approved.target, before);
  if (target.url !== approved.target.url || target.fetchUrl !== approved.target.fetchUrl) throw new Error('远程配置已变化，请重新检查');
  let remoteOid = await fetchDestination(root, target);
  await guard(root, before.revision);
  if (remoteOid !== approved.remoteOid) return { status: 'remote-changed', warning: '远程分支在预览后发生变化，请核对新的提交列表再确认。', ...(await storePreview(root, before, target, remoteOid)) };
  const behind = remoteOid ? Number((await git(root, ['rev-list', '--count', `${before.head}..${remoteOid}`])).trim()) : 0;
  let state = before, updated = false;
  if (behind) {
    const result = await update(root, state, target, remoteOid);
    state = result.state; updated = true;
    if (result.status !== 'success') return { ...result, pushed: false };
  }
  if (action === 'sync-update') {
    return { state, status: 'success', pushed: false, output: updated ? `${target.strategy === 'rebase' ? '变基' : '合并'}更新完成；尚未推送` : remoteOid ? '本地已经包含远程提交，无需更新' : '远程分支尚不存在，无需更新' };
  }
  // Re-fetch after local integration; never silently accept additional remote commits.
  if (updated) {
    try { remoteOid = await fetchDestination(root, target); } catch (error) { return { state: await snapshot(root), status: 'push-failed', warning: '本地更新已完成，但远程检查失败；尚未推送，请重新检查后重试。', output: error.message, pushed: false }; }
    try { await guard(root, state.revision); } catch (error) { return { state: await snapshot(root), status: 'push-failed', warning: '本地更新后仓库又发生变化；尚未推送，请重新核对。', output: error.message, pushed: false }; }
    if (remoteOid !== approved.remoteOid) return { status: 'remote-changed', warning: '本地更新已完成，但远程又有变化；尚未推送，请核对后再确认。', ...(await storePreview(root, state, target, remoteOid)) };
  }
  try { await guard(root, state.revision); } catch (error) { return { state: await snapshot(root), status: 'push-failed', warning: '仓库内容又发生变化；尚未推送，请重新核对。', output: error.message, pushed: false }; }
  let output;
  try {
    output = await git(root, ['-c', `remote.${target.remote}.mirror=false`, 'push', '--porcelain', '--no-force', '--no-follow-tags', '--recurse-submodules=no', '--', target.remote, `${state.head}:${target.ref}`], { timeout: 45000 });
  } catch (error) {
    return { state: await snapshot(root), status: 'push-failed', pushed: false, warning: `${updated ? '本地更新已完成；' : ''}已提交内容仍保留在本地，尚未推送。请重新检查后重试。`, output: cleanError(error, target.url, target.remote) };
  }
  let warning = '';
  try {
    await git(root, ['update-ref', '--no-deref', target.cacheRef, state.head]);
    await updateTracking(root, target, state.head);
    if (target.setUpstream) {
      await git(root, ['config', '--replace-all', `branch.${before.branch}.remote`, target.remote]);
      await git(root, ['config', '--replace-all', `branch.${before.branch}.merge`, target.ref]);
    }
  } catch { warning = '推送已成功，但本机跟踪配置更新失败，请刷新并检查上游设置。'; }
  return { state: await snapshot(root), status: 'success', pushed: true, warning, output: `已推送至 ${target.name}${updated ? `（先${target.strategy === 'rebase' ? '变基' : '合并'}更新）` : ''}` };
}
