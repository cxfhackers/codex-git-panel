# Codex Git 提交面板

在 Codex 中打开的 Git 面板，提供类似 IntelliJ IDEA 提交窗口的工作区文件、暂存区、差异预览、分支、合并、更新与推送操作。它通过本地 MCP App 运行，不修改 Codex 安装包。当前版本 **0.8.7**。

> 此项目是 Codex 的 MCP 工具页面，不是 Chrome 扩展，也不会在 Codex 原生 Git 提交弹窗中插入按钮。安装后可从 Codex 的工具入口打开，或在聊天中调用 `open_git_panel`。

## 安装

需要 Git、Node.js 20.19+、npm 和已安装的 [Codex CLI](https://developers.openai.com/codex/cli)；AI 提交说明还需要 CLI 已登录并可使用模型。目前已在 macOS 验证安装，Linux 可按相同步骤尝试；Windows 路径尚未适配。请把项目放在一个稳定目录，安装后不要移动它。

**方式一：GitHub Release 压缩包**

从 [Releases](https://github.com/cxfhackers/codex-git-panel/releases) 下载最新的 `codex-git-panel-v*.zip`，解压后在该目录运行：

```sh
npm ci --omit=dev
npm run install:codex
```

**方式二：克隆仓库**

```sh
git clone https://github.com/cxfhackers/codex-git-panel.git
cd codex-git-panel
npm ci --omit=dev
npm run install:codex
```

安装脚本会检查面板资源和现有 MCP 配置，并使用当前 Node.js 的绝对路径注册 `git-panel`。如果已有同名但指向其他位置的配置，它会停止并提示核对，不会覆盖。可用 `codex mcp get git-panel --json` 查看安装结果。重新打开 Codex 后，在聊天中调用 `open_git_panel`；也可在 **更多工具 → 插件和 MCP → Git 提交** 中打开（入口名称随 Codex 版本可能变化）。

如果 Codex CLI 不在 `PATH`，设置 `GIT_PANEL_CODEX_COMMAND` 为其可执行文件绝对路径后重试。若自定义了 `CODEX_HOME`，请先创建该目录。手动配置方式见 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)：

```toml
[mcp_servers.git-panel]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/codex-git-panel/server/mcp.mjs"]
tool_timeout_sec = 300
```

安装脚本创建的配置可在 `~/.codex/config.toml` 的 `[mcp_servers.git-panel]` 下补充 `tool_timeout_sec = 300`，给 AI 生成和远程操作留足时间。

## 使用

- 工作区和已暂存列表支持点击预览、Shift 连续多选、Ctrl/⌘ 增减多选，以及批量暂存和移出；文件复选框可立即处理单个文件。
- 仅已暂存内容会进入提交。AI 提交说明会读取实际暂存差异，生成可编辑的中文 Conventional Commit 描述；未暂存内容不会送入这一步。
- 可切换分支、预览并合并分支，处理冲突；有未提交文件时会尽量保留本地改动，涉及覆盖风险时会阻止或备份。Git 操作仍应在确认仓库和目标分支后执行。
- 点击“更新”会直接检查远程并更新当前分支，顶部彩色光条显示执行状态；无需更新时会直接提示。默认按合并方式更新，若此前为该仓库选择过 Rebase，则沿用该设置。推送已提交内容和“提交并推送”仍保留核对流程。远程目标会根据当前分支的 upstream 推断。

默认按 Codex 当前项目的 Git 仓库显示。一个 Codex 项目含多个独立仓库（如前端和后端）时，可复制 `server/project-repositories.example.json` 为本机的 `server/project-repositories.json`，把绝对路径改为自己的仓库路径，重新打开 Codex。该本机配置已被 Git 忽略，不会随仓库上传。也可以把配置放在其他位置，并给 MCP 服务设置 `GIT_PANEL_PROJECTS_FILE` 环境变量。

AI 功能通过本机 Codex CLI 发起。提交说明默认使用 `gpt-6-luna`；可通过 MCP 环境变量 `GIT_PANEL_COMMIT_AI_MODEL` 覆盖，或用 `GIT_PANEL_AI_MODEL` 同时覆盖 AI 提交说明和冲突分析。模型是否可用取决于使用者的 Codex 账号。

## 更新与卸载

更新时下载新版压缩包到原目录，或在克隆目录执行 `git pull`，然后运行 `npm ci --omit=dev`，重新打开 Codex。移动项目目录后要重新配置 MCP 路径。卸载 MCP 配置可运行 `codex mcp remove git-panel`；这只移除 Codex 配置，不会删除本机仓库或面板文件。

## 开发和验证

```sh
npm ci
npm test
npm run build
```

`npm run build` 生成独立网页 `dist/` 和供 Codex MCP 读取的单文件界面 `dist-mcp/index.html`。发布包已包含预构建的 `dist-mcp/index.html`，普通使用者无需安装开发依赖或构建。独立网页可用 `npm start` 在本机启动。面板的文件和 Git 操作通过本地 MCP 服务完成，不要求部署云服务。

源码采用 [MIT License](LICENSE)。
