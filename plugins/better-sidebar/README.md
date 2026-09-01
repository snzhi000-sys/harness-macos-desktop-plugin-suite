# dsh-better-sidebar

<!-- 头部介绍区（HTML 排版） -->
<div align="center">
  <b style="font-size: 1.15em;">一个插件，一套完整工作台</b><br /><br />
  <code>文件管理</code> <code>编辑预览</code> <code>内嵌浏览器</code> <code>真实终端</code> <code>Git 面板</code> <code>后台任务页</code><br /><br />
  <b>右侧栏 + 底部面板双工作台</b>，一个插件全部搞定。<br />
  <small>支持 Tab 窗口随意拖拽，支持三方拓展注册新 Tab 页面和文件预览</small>
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

https://github.com/user-attachments/assets/23187822-047e-45cc-b480-fe997bd55b86

<img width="2630" height="1794" alt="6c4293e1bec2e935031bf0e986d6ec65" src="https://github.com/user-attachments/assets/dfdb875e-a1a8-4d4b-8340-353736b1708f" />

## ✨ 功能一览

- **🗂️ 资源管理器**：懒加载目录树（根 = 会话 cwd）；视频、图片、PDF、新版 Office 进入 Browser/Preview 共用右栏，文本与代码进入顶部「文件」，不支持的二进制格式下载或交给系统兜底；右键可打开、引用、复制路径或在访达定位
- **📝 编辑与预览**：代码、Markdown 与 HTML 继续由顶部「文件」提供 CodeMirror 编辑和安全预览；图片 / 视频 / PDF / DOCX / XLSX / PPTX 在右栏使用独立只读 Preview Tab，并与网页 Browser 共用标签栏；视频基于 Chromium 原生解码与 Range 流式地址，提供统一主题的进度、缓冲、音量、倍速、全屏、画中画和局部键盘控制，切换标签、收起右栏或切换会话会自动暂停并保留进度，关闭标签会取消媒体请求；挂载媒体地址前先以 `HEAD` 检查可读性和类型，元数据 20 秒超时或解码失败会显示明确错误，并提供重试、系统播放器和下载兜底
- **⚡ 客户端懒加载**：Office / 终端 / 代码编辑器等重依赖按需分块加载——启动只拉 ~325KB 核心，打开 .xlsx 才拉 Univer（~20MB）、打开 .docx 只拉 docx 预览器、打开终端才拉 xterm；首次打开短暂 loading 后即用（详见 `docs/plans/2026-08-12-lazy-chunks-design.md`）
- **🚀 首屏调度**：Explorer 根目录立即读取；Host 布局恢复、Emoji 标记校准和非常用路径的磁盘存在性检查在 Harness 首绘后的共享串行队列执行。非常用隐藏意图先用轻量持久快照恢复，避免本应隐藏的文件在启动时短暂闪现；切换会话或工作区会取消尚未开始的旧任务，迟到结果也不会覆盖用户的新操作。
- **🌐 浏览器**：内嵌网页浏览 tab（多开），支持后退/前进/刷新；页面以普通非沙箱 iframe 运行，地址栏仍拒绝 localhost 等本机地址；被站点拒绝嵌入（X-Frame-Options）时显示原因面板；聊天/界面里的 http(s) 外链默认在侧边栏打开（侧边栏折叠时自动展开面板）
- **💻 终端**：xterm.js + node-pty 真实 shell（每会话 3 个 UI 上限）、Tab 保活重连回放；可选为模型注入 8 个 `terminal_*` 工具
- **🌿 Git 面板**：真 diff + VSCode 式 diff tab、懒加载历史、右键暂存/放弃/提交/还原/捡取
- **🧩 后台任务页**：主会话完整 agent 拓扑、点击直达执行记录、实时工具调用轮询、新子代理自动展开；**同页显示后台任务**（当前树全部后台任务，bash/pwsh 类型徽标 + 退出码，点击查看实时输出——自动跟随底部、非消费 peek，不干扰模型的 `job_output`；两击确认可强制终止）
- **🪟 底部面板**：独立的第二个工作台（与右侧栏同类的标签页），只挤占中间 Agent 输出区、不覆盖左右侧边栏；**首次展开自动开一个新终端**（终端卡片二级设置可关）；右上角 x 一键折叠
- **📱 移动端**：视口 < 768px（真正的移动端宽度，不对齐宿主 1024 断点）时只显示右侧栏——进入窄屏时底部面板的标签页**直接并入右侧栏标签条**，右上角只剩一枚开关，面板为全宽抽屉；新会话默认收起，聊天里点文件/外链自动展开，不挤压对话区
- **🔧 分栏工作台**：拖 Tab 拆分/合并分栏（可**跨面板拖 Tab**）、分隔线调比例；右上角持久按钮簇（底栏 + 侧拉 glyph）折叠/展开两个面板；两面板共享拐角双向拖动调节尺寸，拖动 rAF 直写 DOM 保持流畅
- **🔁 会话隔离**：布局/分栏/Tab/两面板状态按会话持久化（localStorage），Explorer Emoji 标签另由 Host 按工作区持久化、不受随机启动端口影响；陈旧状态自动净化；聊天「产出文件」改在侧边栏打开（面板折叠时自动展开）
- **⚙️ 声明式设置**：设置页「侧边卡片」分区按注册表渲染功能清单（小卡片网格，高亮 = 启用），每项可独立开/关；二级设置（子代理自动展开、终端工具、底部面板首展自动开终端、沙箱开关等）经齿轮按钮在原生弹窗中编辑
- **🔌 服务化**：暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏 tab 与文件预览器（内置 8 tab + 10 viewer 也走同一服务，详见 [AGENTS.md](./AGENTS.md)）
- **🌏 多语言**：界面文案跟随 DSH 的语言设置（zh/en）实时切换——Host 偏好优先于浏览器语言，词典注册进 DSH 的 i18n 命名空间；切换语言无需刷新

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 20、pnpm ≥ 10。

**macOS / Linux**（Windows 装了 Git Bash 或 WSL 也可）：

```sh
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash
```

**Windows（PowerShell 5.1+ / pwsh）**：

```powershell
irm https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1 | iex
```

装完**重启 DSH 并硬刷新**（Cmd/Ctrl+Shift+R）即可看到侧边栏。

<details>
<summary><b>指定版本 / 装完自动重启（可选）</b></summary>

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.sh | bash -s 0.10.3 --restart

# Windows PowerShell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'))) -Version 0.10.3 -Restart
```

不确定的话，可先加 `--dry-run`（PowerShell 用 `-DryRun`）预览步骤再执行。

</details>

<details>
<summary><b>手动安装（逐步命令，想看清每一步）</b></summary>

与一键脚本等价。**第 ③ 步可重复执行；①② 只需做一次。**

**macOS / Linux（bash）**：

```sh
cd ~/.dsh/profiles/web

# ① 放行 node-pty / protobufjs 的构建脚本（pnpm 11 默认拦截；pnpm 10 可跳过）
pnpm approve-builds --all

# ② 放行「发布不足 24h」的新版本（装老版本可跳过；若已有该键，把下面那行并入其下即可）
cat >> pnpm-workspace.yaml <<'EOF'
minimumReleaseAgeExclude:
  - dsh-better-sidebar
EOF

# ③ 安装并自动挂载（不带 @版本 = npm 的 latest；固定版本写 dsh-better-sidebar@0.10.3）
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar
```

**Windows（PowerShell）**：

```powershell
cd ~\.dsh\profiles\web

# ① 放行构建脚本
pnpm approve-builds --all

# ② 放行新版本（一次性；若已有该键，把 - dsh-better-sidebar 并入其下即可）
Add-Content -Path pnpm-workspace.yaml -Value "`nminimumReleaseAgeExclude:`n  - dsh-better-sidebar"

# ③ 安装并自动挂载
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar
```

</details>

<details>
<summary><b>脚本内部做了什么（技术细节）</b></summary>

一键脚本自动完成 4 件事（全部幂等，可安全重复执行）：

1. 预写 `allowBuilds`（node-pty / protobufjs），规避 pnpm 11 的构建脚本拦截；
2. 预写 `minimumReleaseAgeExclude`，放行「发布不足 24 小时」的新版本；
3. 执行 `dsh plugin --profile web add dsh-better-sidebar`：登记依赖 → 识别包内 `dsh.bundle.patch` → 自动注册进 `dsh.profile.bundles` 挂载；
4. 清理旧版残留的手动挂载行，避免「双挂载」（页面出现两个侧边栏）。

`curl | bash` / `irm | iex` 会执行远程代码——脚本已随仓库开源（`scripts/install.sh` / `scripts/install.ps1`），可先下载审阅。插件以 npm 包 `dsh-better-sidebar@0.10.3` 发布，通过 `dsh.bundle.patch`（随包的 `cordis.patch.yml`）由官方 CLI 自动挂载，**不修改 DSH 源码**。

</details>

<details>
<summary><b>更新</b></summary>

```sh
dsh plugin --profile web add dsh-better-sidebar
```

或重跑一次一键脚本；也可把 `~/.dsh/profiles/web/package.json` 里的版本号改高后 `pnpm install`。改完**重启 DSH 并硬刷新**（Cmd/Ctrl+Shift+R）。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 报 `Ignored build scripts` | pnpm 11 拦截构建脚本。跑 `pnpm approve-builds --all`（一键脚本已自动处理）。 |
| 报 `minimum release age` / 版本不足 24h | 装的版本发布不足 24 小时。等 24h 或重跑一次（pnpm 会自动补 `minimumReleaseAgeExclude`）；一键脚本已自动处理。 |
| 报「找不到 profile 目录」 | 先跑一次 `dsh web`，让它初始化 `~/.dsh/profiles/web`。 |
| 页面出现**两个侧边栏** | 双挂载：`~/.dsh/profiles/web/cordis.patch.yml` 还留着旧的手动挂载行，删掉那段 `- insert: ... better-sidebar ...`（一键脚本会自动清）。 |
| Windows 下终端无法使用 | `node-pty` 依赖预编译二进制；若当前 Node 版本没有对应产物，需装编译工具链（VS Build Tools）。主流 Node 版本一般已有预编译。 |
| Windows 没有 bash / curl | 直接用 PowerShell 一键命令；或安装 Git Bash / WSL 再跑 bash 命令。 |

</details>

<details>
<summary><b>从源码安装 / 开发（可选，替代 npm 方式）</b></summary>

调试本地改动或跟随开发分支时，把依赖指向本地克隆并自行构建：

```text
1. git clone https://github.com/omdsh-dev/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
2. ~/.dsh/profiles/web/package.json 的 dependencies 写 "dsh-better-sidebar": "link:<克隆目录绝对路径>"
3. ~/.dsh/profiles/web/cordis.patch.yml 追加挂载行：
   - insert:
       - id: better-sidebar
         name: 'dsh-better-sidebar'
4. 在 ~/.dsh/profiles/web 执行 pnpm install
5. 重启 DSH 并硬刷新
```

更新：`git pull && pnpm install && pnpm build` → 重启 DSH（仅 client 改动可硬刷新）。切回 npm 通道时，把依赖改回 `"dsh-better-sidebar": "^0.10.3"` 再 `pnpm install`。

</details>

<details>
<summary><b>通过 plugin-registry 安装（可选，与上述二选一）</b></summary>

前置：DSH 已集成 [plugin-registry](https://github.com/dsh-external/plugin-registry)（`dsh registry` 可用）。**同时启用两个通道会双挂载**（Node 半挂两次、页面两个侧边栏）。

```sh
git clone https://github.com/omdsh-dev/DSH-better-sidebar.git && cd DSH-better-sidebar
pnpm install && pnpm build
node scripts/package-registry.mjs   # 组装 registry/ 暂存（含清单 + 产物 + README，不入库）
dsh registry install ./registry     # 安装（默认禁用）
dsh registry enable dsh-external/dsh-better-sidebar
```

更新：`git pull && pnpm install && pnpm build` → `node scripts/package-registry.mjs` → `dsh registry uninstall/install/enable`。切换通道前先移除另一通道的挂载。

</details>

## ⌨️ 快捷键

| 操作 | 按键 |
|---|---|
| 保存编辑 | `Ctrl/Cmd + S` |
| Git 提交 | `Ctrl + Enter` |
| 关闭 Tab | 鼠标中键 |
| 拆分/合并分栏 | 拖 Tab 到分栏边缘 / 中间 |
| 引用文件到输入框 | 悬浮行尾 `@文件` 按钮 |
| 复制文件路径 | 右键行 → 复制相对/绝对地址 |
| 在访达定位 | 右键文件、文件夹或工程根目录 → 在访达打开 |

## 🔌 服务化：注册 tab 与文件预览器

从 v0.4.0 起暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏页面与文件预览器（内置 8 tab + 10 viewer 也走同一服务，吃自己的狗粮）：

```ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

完整接入文档（`TabDescriptor` / `FileViewerDescriptor` 全字段、匹配算法、HMR 陷阱、声明式设置）：见 [`AGENTS.md`](./AGENTS.md)。

## 🛠️ 开发与构建

```sh
pnpm install      # @deepseek-ai/* 已发布到 npm（^0.1.0-rc.6），直接解析、无需令牌
pnpm typecheck    # tsc --noEmit
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest（含 manifest 一致性守卫，需先 build）
pnpm watch        # tsdown --watch
```

**架构**：单 npm 包、host/client 双半结构——host（`src/index.ts`）：`/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/html` 预览路由、`/sidebar/ws/terminal` WebSocket（fs / git / pty / 预览，全部会话级 + 信任围栏）；`/sidebar/file` 对 MP4/M4V/WebM/MOV/OGV 使用单段 HTTP Range 流式响应与独立 4GB 默认上限，图片/PDF/Office 仍使用 20MB 媒体上限，并通过 `x-dsh-media-error` 区分 missing / too-large / forbidden / range / unreadable / network；client（`src/client/index.tsx`）：portal 侧边栏 + 各视图 + 拦截；常规界面状态按会话持久化 localStorage，Explorer Emoji 标记使用 `$DSH_HOME/state/dsh-better-sidebar/explorer-marks.json`，非常用文件/文件夹标记及隐藏开关使用同目录下的 `explorer-visibility.json`，冷会话标题通过只读 Harness 持久投影恢复。插件按 DSH 官方规范组织（无 default 导出、双 client bundle），运行期不依赖 npm / checkout（`@deepseek-ai/*` 由 web profile 提供）。

## 🔐 安全

- 路由受 Host 头信任围栏保护（与 `/api` 一致）；`fs.write` 原子写入；媒体/预览路由仅限会话 cwd 内文件并拒绝软链接越界；视频 Range 请求每次重新校验边界，客户端断开即销毁文件流；git 只调 CLI、绝不设置身份
- 视频预览不做自动转码、不读取完整文件、不创建大型临时文件；Chromium 无法可靠区分“不支持的视频/音频编码”和“文件损坏”，因此解码错误使用组合说明并提供系统播放器与下载兜底
- HTML 预览继续在**不透明源沙箱 iframe** 中渲染，并保留状态提示与临时解锁；`/sidebar/html` 路由带 CSP `sandbox` + 大小/路径边界
- 浏览器 tab 固定使用非沙箱 iframe；地址栏仍拒绝 `javascript:`/`data:`/`file:` 与 localhost 等本机地址，并保留 `no-referrer` 与权限策略限制

## ⚠️ 已知限制

- Git 无 push/pull/fetch；无文件 watcher（手动刷新）；工具行内文件打开按钮不可拦截
- 终端 Tab 拖到另一分栏会重挂载（shell 重开）
- `.xlsx` 预览不保留单元格样式（SheetJS 社区版限制）；Office/PPTX 预览内联进 client bundle（约 23MB），首次加载较慢
- 被 `X-Frame-Options`/`frame-ancestors` 拒绝嵌入的站点（如 arxiv.org）仍会显示原因面板并允许尝试继续加载；iframe 内部跳转不进后退栈
- HTML 预览渲染的是已保存文件（不反映未保存草稿）
- 移动端（<768px）无底部面板：进入窄屏时其标签页一次性并入右侧栏（迁移后回桌面仍保留在右侧栏），桌面端的底部面板只在宽视口下可用；移动端底部首展自动开终端不触发

## 🖥️ 平台支持

Windows / Linux / macOS 三平台适配（macOS 日常验证；其余经单元测试覆盖）；`node-pty` 优先预编译二进制，失败需编译工具链（Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT）。
