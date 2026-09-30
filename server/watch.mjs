import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './git.mjs';

async function ignoredPaths(root, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'check-ignore', '-z', '--stdin'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { output += data; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.on('close', code => code === 0 || code === 1 ? resolve(output) : reject(new Error(error)));
    child.stdin.on('error', () => {}); child.stdin.end(paths.join('\0') + '\0');
  });
}

// One directory watcher set per active repository; long polls read an in-memory version.
const entries = new Map();
const relevantGit = path => /^(HEAD|index|packed-refs|config|shallow|refs(?:\/|$)|MERGE_|REBASE_|rebase-|CHERRY_PICK_HEAD|REVERT_HEAD|sequencer|git-panel-(?:exclusions|local-changes|changelists)\.json|git-panel-shelves(?:\/|$))/.test(path);
async function createEntry(root) {
  const entry = { version: randomUUID(), handles: new Map(), clients: new Map(), waiters: new Set(), pending: new Map(), closed: false, degraded: false, topology: true };
  const gitDirs = [...new Set(await Promise.all(['--absolute-git-dir', '--git-common-dir'].map(async flag => (await git(root, ['rev-parse', '--path-format=absolute', flag])).trim())))];
  function signal() { entry.version = randomUUID(); for (const notify of entry.waiters) notify(); }
  async function directories() {
    const paths = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
    entry.paths = new Set(paths);
    const dirs = new Map([[root, false]]);
    for (const path of paths) {
      let dir = dirname(join(root, path));
      while (dir.startsWith(root + '/')) { dirs.set(dir, false); dir = dirname(dir); }
    }
    async function refs(dir) {
      dirs.set(dir, true);
      for (const child of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (child.isDirectory()) await refs(join(dir, child.name));
    }
    for (const dir of gitDirs) { dirs.set(dir, true); await refs(join(dir, 'refs')); const shelves = await realpath(join(dir, 'git-panel-shelves')).catch(() => null); if (shelves) dirs.set(shelves, true); }
    if (dirs.size > 2048) entry.degraded = true;
    const wanted = new Map([...dirs].sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 2048));
    for (const [dir, handle] of entry.handles) if (!wanted.has(dir)) { handle.close(); entry.handles.delete(dir); }
    for (const [dir, metadata] of wanted) {
      if (entry.closed || entry.handles.has(dir)) continue;
      try {
        // Never follow a workspace symlink into another directory.
        if (!metadata && await realpath(dir) !== dir) continue;
        if (entry.closed || entry.handles.has(dir)) continue;
        const handle = watch(dir, { persistent: false }, (event, filename) => {
          const name = filename?.toString();
          if (!name) { entry.topology = true; queue(''); return; }
          const absolute = join(dir, name);
          if (metadata) {
            const parent = gitDirs.find(base => absolute.startsWith(base + '/'));
            if (!name.endsWith('.lock') && parent && relevantGit(relative(parent, absolute))) { if (event === 'rename') entry.topology = true; queue('', true); }
          } else {
            const path = relative(root, absolute);
            if (path === '.git' || path.startsWith('.git/') || name.startsWith('.git-panel-edit-')) return;
            queue(path, false, event === 'rename' && !entry.paths.has(path));
          }
        });
        handle.on('error', () => { handle.close(); entry.handles.delete(dir); entry.degraded = true; });
        entry.handles.set(dir, handle);
      } catch { entry.degraded = true; }
    }
  }
  async function flush() {
    entry.timer = null; clearTimeout(entry.maxTimer); entry.maxTimer = null;
    const pending = entry.pending; entry.pending = new Map();
    let changed = pending.has(''), topology = entry.topology; entry.topology = false;
    const paths = [...pending.keys()].filter(Boolean);
    const ignored = new Set();
    // Ignore build/dependency churn before requesting any snapshot or directory scan.
    for (let i = 0; i < paths.length; i += 250) {
      let output;
      try { output = await ignoredPaths(root, paths.slice(i, i + 250)); }
      catch (e) { if (e.code === 1) output = e.stdout; else { output = ''; entry.degraded = true; } }
      for (const path of (output || '').split('\0').filter(Boolean)) ignored.add(path);
    }
    for (const path of paths) if (!ignored.has(path)) { changed = true; topology ||= pending.get(path) || path.endsWith('.gitignore'); }
    if (topology && !entry.closed) await directories().catch(() => { entry.degraded = true; });
    if (changed && !entry.closed) signal();
  }
  function queue(path, metadata = false, topology = false) {
    if (entry.closed) return;
    entry.pending.set(path, topology || entry.pending.get(path));
    clearTimeout(entry.timer); entry.timer = setTimeout(() => flush().catch(() => { entry.degraded = true; signal(); }), 600); entry.timer.unref();
    if (!entry.maxTimer) { entry.maxTimer = setTimeout(() => { clearTimeout(entry.timer); flush().catch(() => { entry.degraded = true; signal(); }); }, 2000); entry.maxTimer.unref(); }
  }
  entry.close = () => {
    entry.closed = true; clearTimeout(entry.timer); clearTimeout(entry.maxTimer); clearInterval(entry.sweep);
    for (const handle of entry.handles.values()) handle.close(); entry.handles.clear();
    for (const notify of entry.waiters) notify();
  };
  entry.sweep = setInterval(() => {
    for (const [client, time] of entry.clients) if (Date.now() - time > 65000) entry.clients.delete(client);
    if (!entry.clients.size) { entry.close(); entries.delete(root); }
    else if (entry.degraded && Date.now() - (entry.lastFallback || 0) >= 60000) { entry.lastFallback = Date.now(); signal(); }
  }, 15000); entry.sweep.unref();
  try { await directories(); } catch (e) { entry.close(); throw e; } entry.topology = false;
  return entry;
}
export async function waitForChanges(root, { client, version = '' }) {
  if (typeof client !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(client)) throw new Error('监听标识无效');
  if (!entries.has(root)) entries.set(root, createEntry(root).catch(error => { entries.delete(root); throw error; }));
  const entry = await entries.get(root);
  entry.clients.set(client, Date.now());
  if (version === entry.version && !entry.closed) await new Promise(resolve => {
    const done = () => { clearTimeout(timer); entry.waiters.delete(done); resolve(); };
    const timer = setTimeout(done, 25000); entry.waiters.add(done);
  });
  if (entry.clients.has(client)) entry.clients.set(client, Date.now());
  return { version: entry.version, changed: version !== entry.version, degraded: entry.degraded, closed: entry.closed };
}
export async function stopWatching(root, client) {
  const entry = await entries.get(root); if (!entry) return {};
  entry.clients.delete(client);
  // Wake long polls so the UI can finish its loop promptly.
  for (const notify of entry.waiters) notify();
  if (!entry.clients.size) { entry.close(); entries.delete(root); }
  return {};
}
