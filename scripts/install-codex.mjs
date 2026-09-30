import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../server/mcp.mjs', import.meta.url));
const bundle = fileURLToPath(new URL('../dist-mcp/index.html', import.meta.url));
try { await access(bundle); }
catch {
  console.error('缺少预构建面板。请下载 GitHub Release，或先运行 npm ci && npm run build。');
  process.exit(1);
}

const candidates = [process.env.GIT_PANEL_CODEX_COMMAND, 'codex'];
if (process.platform === 'darwin') candidates.push(
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
);
let cli;
for (const candidate of candidates.filter(Boolean)) {
  const check = spawnSync(candidate, ['mcp', 'list'], { encoding: 'utf8' });
  if (!check.error && check.status === 0) { cli = candidate; break; }
}
if (!cli) {
  console.error('找不到 Codex CLI。请安装 Codex CLI，或设置 GIT_PANEL_CODEX_COMMAND 为其可执行文件路径。');
  process.exit(1);
}

const existing = spawnSync(cli, ['mcp', 'get', 'git-panel', '--json'], { encoding: 'utf8' });
if (existing.status === 0) {
  let config;
  try { config = JSON.parse(existing.stdout); } catch {}
  const transport = config?.transport;
  if (transport?.command === process.execPath && transport.args?.[0] === server) {
    console.log('Git 面板已经安装在当前路径。');
    process.exit(0);
  }
  console.error('已有名为 git-panel 的 MCP 配置。请先核对现有配置；此安装脚本不会覆盖它。');
  console.error(`当前配置：${existing.stdout.trim()}`);
  process.exit(1);
}

const added = spawnSync(cli, ['mcp', 'add', 'git-panel', '--', process.execPath, server], { encoding: 'utf8' });
if (added.status !== 0) {
  console.error(added.stderr || added.error?.message || '无法添加 MCP 配置');
  process.exit(1);
}
console.log(added.stdout.trim());
console.log('已安装 Git 面板。重新打开 Codex，在聊天中调用 open_git_panel。');
console.log('使用 AI 生成或分析较大差异时，建议在 ~/.codex/config.toml 的 [mcp_servers.git-panel] 下设置 tool_timeout_sec = 300。');
