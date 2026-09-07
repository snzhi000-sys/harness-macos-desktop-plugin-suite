# dsh-file-edit

> 本项目全部代码由 DeepSeek-V4-Pro 与 DeepSeek-V4-Flash 生成。

DSH WebUI 工作区文件插件，核心功能有两块：

1. **工作区文件浏览与编辑**：文件树浏览、多标签打开、语法高亮、Markdown 渲染，并可在浏览器里直接编辑文件内容；
2. **Diff 视图**：对发生变化的文件展示行级 diff，可逐块或整文件接受/拒绝，拒绝后可撤销。

## 功能

- **只读权限**：AI 调用 `file_delete` / `file_move` 时读取当前执行会话的实时 sandbox policy，在工具入口和磁盘修改前拒绝 `read-only`；拒绝不会创建删除隔离批次或改动审核账本。子代理使用自身会话权限，用户手动审核恢复不受该 AI 工具限制。

- **工作区侧边栏**（替换原生浏览器）：项目文件夹两层展开——会话历史（点开会话 / 新建会话；按最近活动时间倒序排列、每行右侧显示「2 min / 1 hr / 1 day」式相对时间标签）与项目文件树（双击/单击打开、手动 ⟳ 刷新、文件集合变化自动刷新）。
- **顶栏「文件」标签**：与「对话/轨迹」并排；内容区是浏览器式标签条（切换 / ✕ 关闭 / ✕ 全部 / 拖拽排序 / ● 修改标记）。统一打开入口也支持工作区外的普通文本文件：Host 将规范化绝对路径换成不透明 ID，文件以只读方式浏览，不开放整文或逐行编辑。
- **单一文件标题**：文件名只在浏览器式文件标签中显示；内容工具栏不重复标题，Markdown / 编辑中 / 修改等状态标签从左侧起排布。
- **单编辑器引用气泡**：引用由 Harness occurrence/backdrop 绘制，输入始终由原生 textarea 负责，Shift+Enter、中文输入法、删除、撤销和长文本滚动不会因引用存在而切换实现。
- **修改文件列表**（输入框上方）：会话中经 agent 文件工具（write/edit/file_delete/file_move）产生的修改/新增/删除，带 +/− 统计、逐文件接受/拒绝、全部接受/拒绝、撤销上次拒绝；对话页与文件页统一限制面板高度，文件较多时滚动内容区并保持顶部折叠和批量操作可用。结构化 `file_delete` 可处理工作区内外文件和目录，删除前必须完整转移到持久隔离区，目录中的每个普通文件分别进入同一删除批次的审核账本。
- **文件标签批量关闭**：标签栏使用固定的三点“更多文件操作”入口，菜单提供“关闭所有文件”和“关闭已处理文件”。后者会先刷新当前会话审核状态，只关闭已经保存、没有待审核内容且没有本地未保存草稿的标签；审核刷新失败时不关闭任何文件。标签滚动区与操作区分离，文件较多时三点按钮和菜单仍保持可见。
- **内联 Diff**：红/绿行级 diff、24 语言语法高亮、块级/文件级接受与拒绝、跳转控件、大文件只读预览、二进制还原。
- **基线制审阅**：整文件接受 = 当前内容成为新基线；局部接受 = 只把该 hunk 结算进基线；局部拒绝 = 只把该 hunk 从磁盘恢复为基线。每次局部操作后都从新的 `base → cur` 重新计算剩余 diff，不持久化顺序型 hunk ID，因此同一文件后续再次被 agent 修改时，已审核内容不会重新出现或误隐藏其他块。整文件拒绝把剩余基线写回磁盘（新增文件拒绝 = 删除文件）；拒绝可撤销（单层）。
- **文件内编辑**：文件视图中直接编辑（contentEditable），用户编辑折入基线、不打扰 agent 的待审 hunks；空文件可直接输入首行。
- **Markdown 渲染视图**：`.md`/`.markdown` 无待审修改时直接渲染（GFM 表格、围栏代码高亮、无行数上限）。
- **事件驱动审核**：write/edit 的完整 before/after 结果会直接写入当前会话账本，包含工作区外的绝对路径文本文件；file_delete/file_move 也在执行时直接记账。审核发现不依赖工作区扫描，也不受文件树 8000 项上限影响。
- **子代理审核归属**：`origin: subagent` 会话中的 write/edit/file_delete/file_move 和历史前台 Shell 事件，沿 `parentSession` 归入最近的可见父会话审核栏；消息编辑 Fork 等普通子会话仍保持独立账本，不会被误合并。
- **工作区外安全审核**：外部条目显示规范化绝对路径和“工作区外”标识，接受/拒绝只使用 Host 签发的会话账本 ID；重启后继续保留，拒绝前会校验磁盘版本，避免覆盖其他会话产生的新修改。
- **事务化删除隔离**：`file_delete` 先生成目录清单和持久 `deletionBatchId`，同盘使用原子移动，跨盘使用分块复制、逐文件 SHA-256 校验后再删除原路径；备份或校验失败时禁止删除。顶层符号链接、文件系统根、用户主目录、当前工作区根和审核状态目录不可作为删除目标，目录内符号链接只备份链接本身而不会跟随。被删大文件拒绝时直接从隔离区恢复，不受普通文本/二进制快照大小限制。
- **删除墓碑审核**：同一会话中新建后又删除的文件不会再按净零变化消失，而是明确显示“本会话新建后删除”。墓碑持久化删除来源、批次、时间与目标；接受表示确认文件继续不存在并结束整条变化，拒绝只撤销删除、恢复隔离内容，并继续保留原来的新增审核。修改后删除同理：拒绝删除后，之前的修改仍保持待审核。
- **原始 Shell 严格审核**：`bash` / `shell` / `pwsh` 每次调用都读取当前会话解析后的 sandbox policy；`read-only` 直接执行，`workspace-write` 必须先建立覆盖完整可写工作区的快照事务。`danger-full-access` 不再被 File Edit 拒绝：每条前台命令可用绝对 `audit_root` 选择磁盘上任意现有目录，省略时依次使用 `workdir` 和会话工作区；命令对全盘保持可读，写入被约束在该次审计根内，根目录先快照再执行。一次性提权仍由 Harness 审批。后台 Shell、持久终端和未受托管的兼容 Shell 继续在派发前拒绝。
- **Shell 修改前快照事务**：Host 会完整枚举明确的可写根目录；macOS 对每个根目录执行一次 APFS 递归 COW，失败时在整树容量和剩余空间校验后物理复制，所有载荷仍逐文件通过 SHA-256 验证。紧凑 manifest 以 mtime/ctime/大小等稳定元数据复用未变化文件的哈希，命令结束后生成完整的新增、修改和删除 change set；watcher 只提供候选路径提示。相同或互相包含的工作区事务会串行到持久账本提交完成，不相交工作区可并行。新增和修改进入普通审核，删除从命令前快照转入持久 quarantine，并复用 `deletionBatchId` 的接受、拒绝与整目录恢复。Host 崩溃后遗留的 running/captured 事务会在重新读取审核栏时继续结算；过期准备态与已提交诊断快照仅在后续可写事务或审核恢复时延迟清理，不进入首屏启动路径。
- **外部服务能力正交**：产品 Profile 通过独立、结构化 Host 工具提供受控能力；当前 `dsh-lark-cli` 只开放选定的飞书命令。普通文档创建、更新、导入和上传直接执行；删除、回滚、退出登录和移除访问权限等高风险操作逐次审批。子进程仅可写 lark-cli 状态目录和临时目录，不能修改工作区文件。
- **目录删除批次审核**：完整目录删除在现有审核栏中聚合为单行，与普通文件行统一显示文件夹图标、路径、红色“删除”标签和批次操作；展开箭头紧跟在目录路径后，点击路径或箭头可展开查看目录内文件。展开后的子文件只显示相对路径，不重复显示父目录已经表达的“删除”或“新建后删除”状态。支持接受整个删除批次，或拒绝并从隔离区恢复整个目录，包括空目录和未跟随的符号链接。顶部“全部接受 / 全部拒绝”也会将完整目录作为一个批次处理，不会遗漏空目录、符号链接或隔离区。工作区外批次继续显示“工作区外”并以每个文件原有 opaque ID 打开。若某个子文件已经单独审核，聚合行自动拆回单文件，批次接口也会拒绝部分恢复。
- **外部产物只读浏览**：回答底部产物、正文文件链接、Explorer 与工具结果共用统一打开协议。工作区外普通文件可在「文件」中打开，但目录会被拒绝；浏览 ID 不能用于保存或逐行编辑。若该外部文件已由 AI 修改并进入审核账本，原有接受/拒绝流程继续有效。
- **即时更新**：agent 改/增/删/移动文件后立即唤醒界面，无需等待全工作区扫描或手动刷新。
- **快照优先的启动恢复**：重启后先立即显示持久化待审核账本，再把仅针对待审核目标的磁盘校准提交到 Harness 首绘后的共享串行队列。该调度不会扫描工作区，也不会降低审核强度；切换会话会取消尚未开始的旧校准，已开始请求的迟到结果仍由会话 token 拒绝落地。

## 一条命令安装（推荐）

需要本机已装 DSH（`~/.dsh/profiles/web` 存在）且能访问 GitHub。PowerShell 中执行：

```powershell
irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1 | iex
```

完成后：**重启 DSH**（加载宿主插件与挂载项），然后 **Ctrl+F5 刷新页面**（加载客户端 bundle）。

> 备选（clone 方式，凭据走 Git Credential Manager）：
> `git clone https://github.com/justarook1e/dsh-file-edit.git "$env:TEMP\dsh-file-edit"; & "$env:TEMP\dsh-file-edit\install.ps1"`

## 手动安装

1. 把本仓库的 `package.json`、`host/`、`client/` 复制到 `~/.dsh/profiles/web/node_modules/dsh-file-edit/`；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-file-edit
         name: dsh-file-edit
   ```

3. 重启 DSH + Ctrl+F5 刷新页面。

`install.ps1` 做的正是这两步（幂等，可重复执行；`-Uninstall` 反向移除）。

## 更新

再次运行安装脚本即可（幂等，覆盖已安装的包）：

```powershell
irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1 | iex
```

或（clone 方式）：`cd "$env:TEMP\dsh-file-edit"; git pull; & .\install.ps1`

## 卸载

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/justarook1e/dsh-file-edit/main/install.ps1))) -Uninstall
```

或（clone 方式）：`& "$env:TEMP\dsh-file-edit\install.ps1" -Uninstall`

或手动删除 `node_modules/dsh-file-edit/` 与 patch 里的 insert 块。重启后生效。

## 仓库结构

```
dsh-file-edit/
├── package.json          # dsh.client: {platform:'web'} + exports["./client"]
├── host/index.mjs        # 宿主插件：扫描/基线/diff/接受拒绝/RPC（POST /dsh-file-edit/api）
├── client/dist/client.js # 浏览器 bundle（__ModuleLoader__.load + factory）
└── install.ps1           # 一键安装/卸载脚本
```

## 运行期数据

- 每会话审阅状态（已结算基线、当前磁盘快照、删除批次关联、撤销记录）存在 `~/.dsh/dsh-file-edit-state/`，由插件自动创建与维护；重启后自动恢复。v7 使用原子替换持久化账本，并兼容读取 v2 至 v6；旧版位置型 hunk decision 仍按 v6 规则迁移。结构化删除和 Shell 删除的原始内容及 `manifest.json` 位于 `<sessionId>/quarantine/<deletionBatchId>/`，未完成的 Shell 生命周期证据位于 `shell-transactions/`。
- 从旧名 `dsh-files` 升级时，宿主首次启动会把旧的 `~/.dsh/dsh-files-state/` 自动迁移过来，待审状态不丢。

## 已知限制

- 替换了原生 WorkspaceBrowser：没有搜索、分组/排序菜单、重命名/删除/归档对话框（保留了添加工作区、打开/新建会话）。
- 跳过目录：`.git` `node_modules` `.venv` `venv` `__pycache__` `.next` `.dsh` `.idea` `.vscode` `.cache` `.turbo` `.pytest_cache` `.mypy_cache` `.ruff_cache` `.eslintcache` `.DS_Store`；树上限 8000 条目 / 16 层。
- 大文件不做行级 diff：>512KB 或 >8000 行标为 `large`（≤512KB 的文本可只读预览前 4000 行）；二进制 ≤4MB 可拒绝还原。
- 可写原始 Shell 只在前台、受管进程树和单次明确审计根范围内开放；`workspace-write` 的根固定为会话工作区，`danger-full-access` 的根可通过 `audit_root` 指向磁盘上的任意现有目录。符号链接根会先解析到真实路径。权限拒绝、审批拒绝、快照失败、审计容量或深度超限、结算冲突使用不同提示。单条命令需要修改多个目录时，`audit_root` 必须选取能够包含这些目标的最窄共同目录；根目录过大或无法完整快照时只拒绝该次命令，不降低为事后 best-effort。已经开始于旧版本的 Shell 删除没有修改前事务时，只能保留不可自动恢复的事故记录。
- 飞书上传等外部服务操作优先使用独立的 `lark_cli` 工具，因为它不经过 Shell 且只能写 lark-cli 状态与临时目录。
- 结构化 `file_delete` 已覆盖文件与目录的事务隔离、删除墓碑和目录批次聚合审核。门禁约束的是 Harness 工具流水线中的 AI 工具，不替代用户在 App 外部或系统终端中的自主文件操作权限。
- `write` 覆盖文件但工具未返回修改前内容时会显示“修改前内容未知”，只能接受或手动处理，不会误报为新增，也不会提供可能破坏数据的自动拒绝。
- 已结算基线和待审状态都会跨插件重启持久化；磁盘若在关闭期间继续变化，打开或审核时仍会按单文件版本校验并要求刷新。

## 许可证

本项目以 **MIT License** 发布（见 [LICENSE](LICENSE)）。

客户端 bundle（`client/dist/client.js`）内嵌了 [markdown-it](https://github.com/markdown-it/markdown-it) v15.0.0 的浏览器 UMD 构建，其中包含 linkify-it、mdurl、uc.micro。这些依赖同样以 MIT 发布，其版权声明与完整许可证文本见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
