// Temporary local QA host: exercises the real MCP UI bridge, not Codex's native menu.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { git } from '../server/git.mjs';
const base = fileURLToPath(new URL('../', import.meta.url));
const c = new Client({ name: 'git-panel-browser-qa', version: '0.8.7' });
await mkdir(base + '../../work/git-panel-qa', { recursive: true });
const workspace = await mkdtemp(base + '../../work/git-panel-qa/mcp-browser-');
const syncQa = process.env.GIT_PANEL_QA_SYNC === '1';
const root = syncQa ? workspace + '/frontend' : workspace;
if (syncQa) await mkdir(root);
let backend, remote, other, configFile;
const branchQa = process.env.GIT_PANEL_QA_BRANCHES === '1';
await git(root, ['init', '-b', branchQa || syncQa ? 'main' : 'mcp-demo']);
await git(root, ['config', 'user.name', 'Git Panel QA']); await git(root, ['config', 'user.email', 'qa@example.invalid']);
await git(root, ['config', 'commit.gpgsign', 'false']); await git(root, ['config', 'core.hooksPath', '/dev/null']);
await mkdir(root + '/src');
await writeFile(root + '/src/WorkHours.vue', '<script setup>\nconst width = 120;\nconst hours = 0;\n</script>\n');
await writeFile(root + '/README.md', '# MCP Demo\n');
await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
if (syncQa) {
  backend = workspace + '/backend'; remote = workspace + '/remote.git'; other = workspace + '/other'; configFile = workspace + '/projects.json';
  await mkdir(remote); await git(remote, ['init', '--bare', '-b', 'main']);
  await git(root, ['remote', 'add', 'origin', remote]); await git(root, ['push', '-u', 'origin', 'main']);
  await git(root, ['branch', 'feature/sidebar']);
  await writeFile(root + '/src/WorkHours.vue', '<script setup>\nconst width = 160;\nconst hours = 8;\n</script>\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', '完善工时展示']);
  await git(workspace, ['clone', remote, other]);
  await git(other, ['config', 'user.name', 'Remote QA']); await git(other, ['config', 'user.email', 'qa@example.invalid']); await git(other, ['config', 'commit.gpgsign', 'false']); await git(other, ['config', 'core.hooksPath', '/dev/null']);
  await writeFile(other + '/remote-change.txt', 'Remote update\n'); await git(other, ['add', '.']); await git(other, ['commit', '-m', '更新接口说明']); await git(other, ['push']);
  await mkdir(backend); await git(backend, ['init', '-b', 'backend-dev']);
  await git(backend, ['config', 'user.name', 'Backend QA']); await git(backend, ['config', 'user.email', 'qa@example.invalid']); await git(backend, ['config', 'commit.gpgsign', 'false']); await git(backend, ['config', 'core.hooksPath', '/dev/null']);
  await writeFile(backend + '/service.js', 'export const enabled = false;\n'); await git(backend, ['add', '.']); await git(backend, ['commit', '-m', 'Backend initial']);
  await writeFile(configFile, JSON.stringify({ groups: [{ label: '项目管理系统 · 验证仓库', repositories: [{ label: '前端 · frontend', root }, { label: '后端 · backend', root: backend }] }] }));
} else if (branchQa) {
  await git(root, ['switch', '-c', 'feature/conflict']);
  await writeFile(root + '/src/WorkHours.vue', '<script setup>\nconst width = 200;\nconst hours = 16;\n</script>\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Conflicting work hours']);
  await git(root, ['switch', 'main']); await git(root, ['switch', '-c', 'feature/weekly']);
  await writeFile(root + '/src/WorkHours.vue', '<script setup>\nconst width = 160;\nconst hours = 8;\n</script>\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Update weekly work hours']);
  await git(root, ['switch', 'main']); await writeFile(root + '/main-change.txt', 'Independent main change\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Main branch change']);
} else {
  await writeFile(root + '/src/WorkHours.vue', '<script setup>\nconst width = 160;\nconst hours = 8;\n</script>\n');
  await writeFile(root + '/README.md', '# MCP Demo\nUnrelated change stays in the worktree.\n');
  if (process.env.GIT_PANEL_QA_MANY_FILES === '1') {
    for (let number = 1; number <= 25; number++) {
      await writeFile(root + `/src/Extra-${String(number).padStart(2, '0')}.ts`, `export const item = ${number};\n`);
    }
  }
}
await c.connect(new StdioClientTransport({ command: process.execPath, args: [base + 'server/mcp.mjs'], cwd: root, ...(configFile ? { env: { ...process.env, GIT_PANEL_PROJECTS_FILE: configFile } } : {}), stderr: 'pipe' }));
const token = randomBytes(24).toString('hex');
const server = http.createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); return res.end(); }
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.url === '/app') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const html = (await c.readResource({ uri: 'ui://git-panel/0.8.7/main.html' })).contents[0].text;
      return res.end(process.env.GIT_PANEL_QA_NO_POPOVER === '1' ? html.replace('<head>', '<head><script>HTMLElement.prototype.showPopover = undefined;</script>') : html);
    }
    if (req.url === '/rpc' && req.method === 'POST') {
      if (req.headers.origin !== origin || req.headers['x-qa-token'] !== token) { res.writeHead(403); return res.end(); }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1200000) throw new Error('request too large'); }
      const args = JSON.parse(raw); console.log('QA tool:', args.name);
      // Optional latency injection verifies optimistic UI and stale-write recovery against real Git.
      if (args.name === 'git_set_files_staged' && process.env.GIT_PANEL_QA_STAGING_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.GIT_PANEL_QA_STAGING_DELAY_MS)));
      const response = await c.callTool(args, undefined, { timeout: 300000 });
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(response));
    }
    if (req.url !== '/') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><title>MCP Git 面板 · 桥接验证</title><style>body{margin:0;background:#1e1f22;color:#aeb8c8;font:12px system-ui}header{height:32px;display:flex;align-items:center;padding:0 12px;background:#29303b}iframe{display:block;width:100%;height:calc(100dvh - 32px);border:0}</style><header id="status">MCP 桥接验证宿主 · 临时仓库</header><iframe title="Git MCP 面板" src="/app" sandbox="allow-scripts allow-same-origin"></iframe><script>
    const frame=document.querySelector('iframe');
    window.addEventListener('message',async event=>{
      if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
      const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
      if(m.method==='ui/notifications/initialized'){document.querySelector('#status').textContent='MCP 桥接已连接（此页不是 Codex 原生入口）';return;}
      if(m.id===undefined)return;
      try{
        let result;
        if(m.method==='ui/initialize')result={protocolVersion:m.params.protocolVersion,hostInfo:{name:'Git Panel QA Host',version:'0.2.0'},hostCapabilities:{serverTools:{},serverResources:{}},hostContext:{theme:'dark',platform:'desktop',displayMode:'inline'}};
        else if(m.method==='tools/call'){
          const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json','x-qa-token':${JSON.stringify(token)}},body:JSON.stringify(m.params)});result=await r.json();
        }else if(m.method==='ping')result={};else throw new Error('unsupported method');
        frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);
      }catch(e){frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}},location.origin);}
    });</script></html>`);
  } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, root, backend, remote, other, workspace })));
async function close() { server.close(); await c.close(); await rm(workspace, { recursive: true, force: true }); process.exit(); }
process.once('SIGTERM', close); process.once('SIGINT', close);
