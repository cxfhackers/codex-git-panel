import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { repository, snapshot, diff, mutate } from './git.mjs';
import { session, scopedRepository } from './projects.mjs';
import { syncTargets } from './sync.mjs';
import { branchList, mergePreview } from './branches.mjs';
import { conflictPreview } from './conflicts.mjs';
const base = dirname(dirname(fileURLToPath(import.meta.url)));
const token = randomBytes(32).toString('hex');
const repos = new Map(); const locks = new Map();
function send(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 1200000) throw new Error('请求过大'); }
  return JSON.parse(text || '{}');
}
const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${server.address().port}` && host !== `localhost:${server.address().port}`) return send(res, 403, { error: '无效的主机' });
  const url = new URL(req.url, `http://${host}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  try {
    if (url.pathname === '/api/session' && req.method === 'GET') return send(res, 200, { token, ...session });
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-git-panel-token'] !== token) return send(res, 403, { error: '请重新打开 Git 标签页' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: '不允许跨站请求' });
      if (url.pathname === '/api/open' && req.method === 'POST') {
        const input = await body(req); const root = await scopedRepository(input.root, session);
        const id = [...repos].find(([, knownRoot]) => knownRoot === root)?.[0] || randomBytes(12).toString('hex'); repos.set(id, root);
        return send(res, 200, { id, state: await snapshot(root) });
      }
      const id = url.searchParams.get('id'); const root = repos.get(id);
      if (!root) return send(res, 400, { error: '请先选择仓库' });
      if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await snapshot(root));
      if (url.pathname === '/api/sync-targets' && req.method === 'GET') return send(res, 200, await syncTargets(root));
      if (url.pathname === '/api/branches' && req.method === 'GET') return send(res, 200, await branchList(root));
      if (url.pathname === '/api/merge-preview' && req.method === 'POST') return send(res, 200, await mergePreview(root, await body(req)));
      if (url.pathname === '/api/conflict' && req.method === 'POST') { const input = await body(req); return send(res, 200, await conflictPreview(root, input.path, input.revision)); }
      if (url.pathname === '/api/diff' && req.method === 'GET') return send(res, 200, { patch: await diff(root, url.searchParams.get('path'), url.searchParams.get('staged') === 'true') });
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const input = await body(req);
        if (input.action === 'conflict-ai') return send(res, 200, await mutate(root, input.action, input));
        const previous = locks.get(root) || Promise.resolve();
        const task = previous.catch(() => {}).then(() => mutate(root, input.action, input)); locks.set(root, task);
        try { return send(res, 200, await task); } finally { if (locks.get(root) === task) locks.delete(root); }
      }
      return send(res, 404, { error: '未知接口' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: '不支持的请求' });
    const dist = join(base, 'dist'); const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    const file = await realpath(join(dist, requested));
    if (!file.startsWith(dist + '/')) return send(res, 403, { error: '非法路径' });
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(await readFile(file));
  } catch (e) { send(res, 400, { error: e.message }); }
});
server.listen(Number(process.env.GIT_PANEL_PORT || 43127), '127.0.0.1', () => console.log(`Git panel: http://127.0.0.1:${server.address().port}`));
