import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, mkdir, readFile, readdir, rename, unlink, link, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { git, snapshot } from './git.mjs';
import { validPath } from './exclusions.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const blobSizes = new WeakMap();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function equal(a, b) { return !a && !b || Boolean(a && b && a.mode === b.mode && a.blob === b.blob); }
function plain(bytes) { if (bytes.includes(0)) return null; try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; } }
async function directory(root) {
  return join((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(), 'git-panel-shelves');
}
function validateId(id) { if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('搁置记录无效'); }
async function persist(root, record) {
  const dir = await directory(root); await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicJson(dir, record.id + '.json', record);
  // Listing shelves never needs to read or decode their potentially large backups.
  await atomicJson(dir, record.id + '.meta.json', publicRecord(record));
}
async function atomicJson(dir, name, value) {
  const temporary = join(dir, '.' + randomUUID()), target = join(dir, name);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); await rename(temporary, target); }
  finally { await handle.close().catch(() => {}); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
function publicRecord(record) {
  return { id: record.id, name: record.name, createdAt: record.createdAt, groupId: record.groupId, branch: record.branch, phase: record.phase,
    restoredPaths: record.restoredPaths || [], restoredAt: record.restoredAt || null,
    files: record.files.map(({ path, oldPath, kind }) => ({ path, ...(oldPath ? { oldPath } : {}), kind })) };
}
async function load(root, id) {
  validateId(id);
  const filename = join(await directory(root), id + '.json'), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES * 1.5 + 1024 * 1024) throw new Error('搁置记录损坏或过大');
  const record = JSON.parse(await readFile(filename, 'utf8'));
  if (record.version !== 1 || record.id !== id || !Array.isArray(record.files) || !record.files.length || record.files.length > 500 || !record.blobs || typeof record.blobs !== 'object') throw new Error('搁置记录格式不正确');
  const paths = new Set();
  for (const file of record.files) {
    if (!validPath(file.path) || !Array.isArray(file.entries) || !file.entries.length || file.entries.length > 2) throw new Error('搁置文件路径无效');
    for (const entry of file.entries) {
      if (!validPath(entry.path) || paths.has(entry.path)) throw new Error('搁置文件路径无效'); paths.add(entry.path);
      for (const version of [entry.base, entry.index, entry.work]) {
        if (!version) continue;
        if (!['100644', '100755'].includes(version.mode) || !/^[a-f0-9]{64}$/.test(version.blob) || typeof record.blobs[version.blob] !== 'string' || digest(Buffer.from(record.blobs[version.blob], 'base64')) !== version.blob) throw new Error('搁置文件备份损坏');
      }
    }
  }
  return record;
}
export async function listShelves(root) {
  const dir = await directory(root); let names;
  try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return (await Promise.all(names.filter(name => idPattern.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).map(async name => {
    const id = name.slice(0, -5);
    try {
      const metadata = JSON.parse(await readFile(join(dir, id + '.meta.json'), 'utf8'));
      if (metadata.id !== id || !Array.isArray(metadata.files) || typeof metadata.createdAt !== 'string') throw new Error('invalid metadata');
      return metadata;
    } catch {
      // Recover an interrupted first write using the durable full backup.
      return publicRecord(await load(root, id));
    }
  }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function addBlob(record, data, mode) {
  const blob = digest(data);
  if (!record.blobs[blob]) {
    const bytes = blobSizes.get(record) ?? Object.values(record.blobs).reduce((sum, value) => sum + Buffer.byteLength(value, 'base64'), 0);
    if (bytes + data.length > MAX_BYTES) throw new Error('本次搁置超过 32 MiB，请分批选择文件');
    record.blobs[blob] = data.toString('base64');
    blobSizes.set(record, bytes + data.length);
  }
  return { mode, blob };
}
const bytesOf = (record, version) => version ? Buffer.from(record.blobs[version.blob], 'base64') : Buffer.alloc(0);
async function safeParents(root, path, create = false) {
  const segments = path.split('/').slice(0, -1); let current = root;
  for (const segment of segments) {
    current = join(current, segment); let info;
    try { info = await lstat(current); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!create) return;
      await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`不支持链接或非目录中的文件：${path}`);
  }
}
async function workVersion(root, path, record) {
  if (!validPath(path)) throw new Error('文件路径无效');
  await safeParents(root, path);
  let handle;
  try { handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ENOENT') return { version: null, token: 'missing' }; throw new Error(`无法读取搁置文件 ${path}：${e.message}`); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error(`搁置仅支持不超过 32 MiB 的普通文件：${path}`);
    const data = await handle.readFile(); if (data.length > MAX_BYTES) throw new Error('文件过大');
    const mode = info.mode & 0o111 ? '100755' : '100644', version = addBlob(record, data, mode);
    return { version, token: digest(Buffer.from(`${version.blob}:${mode}:${info.ino}:${info.mtimeMs}`)) };
  } finally { await handle.close(); }
}
async function gitVersions(root, paths, record, tree) {
  const raw = tree ? await git(root, ['ls-tree', '-z', tree, '--', ...paths]) : await git(root, ['ls-files', '--stage', '-z', '--', ...paths]);
  const result = new Map();
  for (const row of raw.split('\0').filter(Boolean)) {
    const split = row.indexOf('\t'), path = row.slice(split + 1), fields = row.slice(0, split).split(' ');
    const [mode, oid] = tree ? [fields[0], fields[2]] : [fields[0], fields[1]];
    if (!paths.includes(path)) continue;
    if (!['100644', '100755'].includes(mode) || !tree && fields[2] !== '0') throw new Error(`暂不支持搁置链接、子模块或冲突文件：${path}`);
    result.set(path, addBlob(record, await git(root, ['cat-file', 'blob', oid], { encoding: null }), mode));
  }
  return result;
}
async function gitInput(root, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', '-C', root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = []; const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', data => output.push(data)); child.stderr.on('data', data => errors.push(data));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(output).toString('utf8')) : reject(new Error(Buffer.concat(errors).toString('utf8') || 'Git 搁置操作失败')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function setIndex(root, entries, record) {
  let input = '';
  for (const { path, version } of entries) {
    const oid = version ? (await gitInput(root, ['hash-object', '-w', '--stdin'], bytesOf(record, version))).trim() : '0'.repeat(40);
    input += `${version?.mode || '0'} ${oid}\t${path}\0`;
  }
  await gitInput(root, ['update-index', '-z', '--index-info'], input);
}
// Displace first and verify the exact file we moved. A concurrently created target
// makes link() fail instead of overwriting the user's newer content.
async function replaceWork(root, path, expected, version, record) {
  await safeParents(root, path, Boolean(version));
  const absolute = join(root, path), dir = dirname(absolute);
  if ((await workVersion(root, path, record)).token !== expected) throw new Error(`文件已被外部修改：${path}`);
  if (expected === 'missing' && !version) return 'missing';
  const backup = join(dir, '.git-panel-edit-shelf-' + randomUUID());
  const temporary = join(dir, '.git-panel-edit-shelf-' + randomUUID()); let displaced = false, installed = false;
  try {
    if (version) {
      const handle = await open(temporary, 'wx', version.mode === '100755' ? 0o755 : 0o644);
      try { await handle.writeFile(bytesOf(record, version)); await handle.sync(); } finally { await handle.close(); }
    }
    if (expected !== 'missing') {
      await rename(absolute, backup); displaced = true;
      const relative = backup.slice(root.length + 1);
      if ((await workVersion(root, relative, record)).token !== expected) throw new Error(`文件已被外部修改：${path}`);
    }
    if (version) { await link(temporary, absolute); installed = true; await unlink(temporary); }
    if (displaced) { await unlink(backup); displaced = false; }
    return (await workVersion(root, path, record)).token;
  } catch (error) {
    if (displaced && !installed) {
      try { await link(backup, absolute); await unlink(backup); displaced = false; }
      catch { throw new Error(`${error.message}；较早版本保留在 ${backup}，请核对两个文件`); }
    }
    throw error;
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
function selectedFiles(before, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 500 || paths.some(path => !validPath(path))) throw new Error('请选择需要搁置的文件（最多 500 个）');
  const selected = [...new Set(paths)].map(path => before.files.find(file => file.path === path));
  if (selected.some(file => !file || file.conflict)) throw new Error('所选文件已变化或存在冲突，请先核对');
  return selected;
}
async function assertRevision(root, before) {
  if ((await snapshot(root)).revision !== before.revision) throw new Error('仓库内容已变化，请重新核对后再操作');
}
export async function createShelf(root, before, body) {
  if (before.operation) throw new Error('请先结束正在进行的合并或恢复，再搁置文件');
  const files = selectedFiles(before, body.paths);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 120 || name.includes('\0')) throw new Error('搁置名称不能超过 120 个字符');
  const record = { version: 1, id: randomUUID(), name: name || `搁置 ${new Date().toLocaleString('zh-CN')}`, createdAt: new Date().toISOString(), head: before.head,
    branch: before.branch, groupId: typeof body.groupId === 'string' ? body.groupId.slice(0, 120) : 'changes', phase: 'saved', restoredPaths: [], files: [], blobs: {} };
  const paths = [...new Set(files.flatMap(file => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))];
  const base = before.head ? await gitVersions(root, paths, record, before.head) : new Map(), index = await gitVersions(root, paths, record);
  const entries = [], seen = new Set();
  for (const file of files) {
    const fileEntries = [];
    for (const path of [file.path, ...(file.oldPath ? [file.oldPath] : [])]) {
      if (seen.has(path)) continue; seen.add(path);
      const work = await workVersion(root, path, record);
      const entry = { path, base: base.get(path) || null, index: index.get(path) || null, work: work.version, token: work.token };
      fileEntries.push(entry); entries.push(entry);
    }
    if (fileEntries.length) record.files.push({ path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), kind: file.kind, entries: fileEntries });
  }
  await assertRevision(root, before); await persist(root, record);
  const completed = [];
  try {
    for (const entry of entries) {
      const token = await replaceWork(root, entry.path, entry.token, entry.base, record); completed.push({ entry, token });
    }
    await setIndex(root, entries.map(entry => ({ path: entry.path, version: entry.base })), record);
  } catch (error) {
    const failures = [];
    for (const { entry, token } of completed.reverse()) {
      try { await replaceWork(root, entry.path, token, entry.work, record); } catch (rollback) { failures.push(rollback.message); }
    }
    record.phase = failures.length ? 'incomplete' : 'saved'; await persist(root, record);
    throw new Error(`搁置未完成，备份“${record.name}”已保留。${error.message}${failures.length ? '\n' + failures.join('\n') : '；所处理的文件已恢复'}`);
  }
  record.phase = 'shelved'; await persist(root, record);
  return { status: 'success', shelf: publicRecord(record), output: `已搁置 ${record.files.length} 个文件：${record.name}` };
}
async function mergeVersion(record, base, current, incoming) {
  if (equal(current, base)) return { version: incoming };
  if (equal(incoming, base) || equal(current, incoming)) return { version: current };
  const texts = [base, current, incoming].map(version => version && plain(bytesOf(record, version)));
  if (!base || !current || !incoming || texts.some(text => text === null) || texts.some(text => text.length > 1024 * 1024)) return { conflict: true, merged: null };
  const folder = await mkdtemp(join(tmpdir(), 'git-panel-shelf-merge-'));
  try {
    for (const [i, name] of ['base', 'current', 'shelf'].entries()) { const handle = await open(join(folder, name), 'wx'); await handle.writeFile(texts[i]); await handle.close(); }
    let merged, conflict = false;
    try { merged = await git(folder, ['merge-file', '-p', '--diff3', '-L', '当前文件', '-L', '搁置前版本', '-L', '搁置版本', 'current', 'base', 'shelf']); }
    catch (error) { if (Number.isInteger(error.code) && error.code > 0 && error.code < 128) { merged = error.stdout; conflict = true; } else throw error; }
    const mode = current.mode === base.mode ? incoming.mode : current.mode;
    return conflict ? { conflict, merged } : { version: addBlob(record, Buffer.from(merged), mode) };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
function conflictDetails(record, entry, current, merged, token, indexConflict) {
  const base = entry.base && plain(bytesOf(record, entry.base)), incoming = entry.work && plain(bytesOf(record, entry.work)), text = current && plain(bytesOf(record, current));
  return { path: entry.path, base, current: text, incoming, merged: merged ?? text ?? incoming ?? '', token,
    binary: Boolean(entry.base && base === null || current && text === null || entry.work && incoming === null),
    deleted: !entry.work, currentDeleted: !current, indexConflict, canEdit: Boolean(current || entry.work) && !(entry.base && base === null || current && text === null || entry.work && incoming === null) };
}
export async function restoreShelf(root, before, body) {
  if (before.operation || before.files.some(file => file.conflict)) throw new Error('请先完成当前冲突或恢复操作，再应用搁置');
  const record = await load(root, body.shelfId);
  const selected = body.paths === undefined ? record.files : selectedFiles({ files: record.files }, body.paths);
  const entries = selected.flatMap(file => file.entries), paths = entries.map(entry => entry.path);
  const index = await gitVersions(root, paths, record), plans = [], conflicts = [];
  const resolutions = body.resolutions || [];
  if (!Array.isArray(resolutions) || resolutions.length > entries.length || resolutions.some(value => !value || !paths.includes(value.path))) throw new Error('搁置冲突处理内容无效');
  for (const entry of entries) {
    const work = await workVersion(root, entry.path, record), currentIndex = index.get(entry.path) || null;
    const [workMerge, indexMerge] = await Promise.all([mergeVersion(record, entry.base, work.version, entry.work), mergeVersion(record, entry.base, currentIndex, entry.index)]);
    let target = workMerge.version, targetIndex = indexMerge.version;
    if (workMerge.conflict || indexMerge.conflict) {
      const resolution = resolutions.find(value => value.path === entry.path);
      if (!resolution) { conflicts.push(conflictDetails(record, entry, work.version, workMerge.merged, work.token, Boolean(indexMerge.conflict))); continue; }
      if (resolution.token !== work.token) throw new Error(`文件已被外部修改，请重新检查搁置冲突：${entry.path}`);
      if (resolution.choice === 'current') { target = work.version; targetIndex = currentIndex; }
      else if (resolution.choice === 'shelf') { target = entry.work; targetIndex = indexMerge.conflict ? currentIndex : indexMerge.version; }
      else if (typeof resolution.content === 'string' && !resolution.content.includes('\0') && Buffer.byteLength(resolution.content) <= 1024 * 1024 && conflictDetails(record, entry, work.version, workMerge.merged, work.token, true).canEdit) {
        if (/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)(?: |$)/m.test(resolution.content)) throw new Error(`请先移除冲突标记：${entry.path}`);
        target = addBlob(record, Buffer.from(resolution.content), work.version?.mode || entry.work?.mode || '100644'); targetIndex = indexMerge.conflict ? currentIndex : indexMerge.version;
      } else throw new Error('请选择保留当前、使用搁置版本，或提供有效的合并文本');
    }
    plans.push({ entry, token: work.token, original: work.version, originalIndex: currentIndex, target, targetIndex });
  }
  if (conflicts.length) return { status: 'conflict', shelf: publicRecord(record), conflicts, output: '所选搁置与当前文件存在重叠修改，请合并后恢复；当前文件尚未改变。' };
  await assertRevision(root, before);
  const completed = [];
  try {
    for (const plan of plans) {
      const token = equal(plan.original, plan.target) ? plan.token : await replaceWork(root, plan.entry.path, plan.token, plan.target, record);
      completed.push({ plan, token });
    }
    await setIndex(root, plans.map(plan => ({ path: plan.entry.path, version: plan.targetIndex })), record);
  } catch (error) {
    const failures = [];
    for (const { plan, token } of completed.reverse()) {
      if (equal(plan.original, plan.target)) continue;
      try { await replaceWork(root, plan.entry.path, token, plan.original, record); } catch (rollback) { failures.push(rollback.message); }
    }
    throw new Error(`恢复未完成，原搁置仍完整保留。${error.message}${failures.length ? '\n' + failures.join('\n') : '；已恢复操作前的文件'}`);
  }
  record.restoredPaths = [...new Set([...(record.restoredPaths || []), ...selected.map(file => file.path)])]; record.restoredAt = new Date().toISOString();
  await persist(root, record);
  return { status: 'success', shelf: publicRecord(record), paths: selected.map(file => file.path), affectedPaths: paths, groupId: body.groupId || record.groupId,
    output: `已恢复 ${selected.length} 个文件：${record.name}；搁置备份继续保留` };
}
export async function shelfDiff(root, shelfId, path) {
  const record = await load(root, shelfId), file = record.files.find(file => file.path === path);
  if (!file) throw new Error('文件不在此搁置中');
  const folder = await mkdtemp(join(tmpdir(), 'git-panel-shelf-diff-')); const patches = [];
  try {
    for (const entry of file.entries) {
      const base = join(folder, 'base'), incoming = join(folder, 'shelf');
      for (const [version, location] of [[entry.base, base], [entry.work, incoming]]) { const handle = await open(location, 'w'); await handle.writeFile(bytesOf(record, version)); await handle.close(); }
      let patch = '';
      try { patch = await git(folder, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', entry.base ? 'base' : '/dev/null', entry.work ? 'shelf' : '/dev/null']); }
      catch (error) { if (error.code === 1) patch = error.stdout; else throw error; }
      const quoted = name => /[\s"\\]/.test(name) ? JSON.stringify(name) : name;
      patch = patch.replace(/^diff --git .*$/m, `diff --git ${quoted('a/' + entry.path)} ${quoted('b/' + entry.path)}`)
        .replace(/^--- .*$/m, '--- ' + (entry.base ? quoted('a/' + entry.path) : '/dev/null'))
        .replace(/^\+\+\+ .*$/m, '+++ ' + (entry.work ? quoted('b/' + entry.path) : '/dev/null'));
      patches.push(patch);
    }
    return { patch: patches.join('\n'), path, shelf: publicRecord(record) };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
