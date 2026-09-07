# Agent Note：受控 lark-cli Host 工具

状态：已实现

[English](2026-09-04-controlled-lark-cli.md) | 中文

## 问题

File Edit 的严格门禁正确阻止了可写原始 Shell，但 `lark-cli` 必须先在用户 macOS Application Support 目录下刷新 OAuth 状态，才能上传文档。通过 `shell_readonly` 运行会因此失败；放宽 Shell 门禁又会让任意进程绕过文件审核账本。

## 决策

产品新增独立的 Host-only 插件 `dsh-lark-cli`。它只注册一个 `lark_cli` 工具，接收 argv 数组，并通过 `ctx.subprocess` 与完整的 `ctx.sandbox` 限制执行固定可信二进制。可写根固定为 lark-cli 状态目录；系统临时目录按沙箱契约保持可用，当前工作区对子进程仍不可写。

工具只接受显式列举的 `auth`、`docs`、`drive`、`wiki` 和 `markdown` 快捷命令。原始 API/资源命令、Profile/配置修改、自更新、Skill 读取、目录同步、剪贴板或 URL 摄取、调用方指定输出路径、后台执行和终端均被拒绝。上传路径与 `@file` 载荷经过 realpath 校验和规范化，必须位于当前调用 Session 的工作区内。Shell 元字符只会作为普通 argv 数据传递。

远程写操作必须调用 `ctx.approval.request()`，且只有 `allowed-once` 才继续。输出有容量上限并脱敏凭据令牌；短期 OAuth device code 只为官方两阶段登录流程保留。子进程只接收最小环境，并受有界超时和受管进程树终止约束。

## 考虑过的替代方案

**只按 lark-cli 命令文本放行 `bash`。** 未采用，因为命令解析无法限制动态程序、环境行为、辅助进程、重定向或 CLI 后续新增的逃生入口。

**新增以凭据目录为根的通用可写 Shell。** 未采用，因为任意程序仍可获得与飞书无关的网络和状态副作用，并且缺少命令级审批和路径校验。

**在 dsh-file-edit 内加入例外。** 未采用，因为外部服务授权不属于文件审核所有权，把两条独立安全边界耦合在一起会扩大维护风险。

## 验证

插件测试覆盖命令矩阵、精确 argv 传递、路径及符号链接 containment、审批结果、dry-run、完整沙箱门禁、超时取消、输出脱敏和插件注册。产品 Profile 验证除包身份与 Cordis composition 外，还检查打包模块的 schema 和模型提示注册。现有 File Edit 测试继续固定单调原始 Shell 门禁。

## 后果

Harness Agent 可以在没有可写原始 Shell 的情况下执行经批准的飞书写入和 OAuth 刷新。工作区变更仍只能经过 File Edit 审核工具。首版有意不把下载产物写入工作区，也不开放全部 lark-cli 域；这些能力需要后续独立设计结构化交付和权限策略。
