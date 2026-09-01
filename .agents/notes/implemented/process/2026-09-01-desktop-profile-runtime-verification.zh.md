# Agent Note: 验证桌面产品插件的实际运行装配

Status: implemented

[English](2026-09-01-desktop-profile-runtime-verification.md) | 中文

## Problem

桌面 Profile 包含某个 NPM 包，不代表它的 Cordis patch 已经挂载，也不代表它的 Client bundle 已经发布。仅检查压缩包内容和后端就绪状态，无法证明定制桌面 App 依赖的产品插件真实可用。

## Decision

`distribution/profile-manifest.json` 为每个必需产品插件记录包名、Cordis 配置项 id 和 Client 要求。桌面打包命令在准备[干净产品 Profile](../feature/2026-08-27-desktop-clean-plugin-distribution.md) 与运行时之后、调用 Electron Builder 之前运行 `verify:profile-runtime`。

验证器将两个压缩包解压到新建的临时目录，检查 Profile 的组合包顺序与包身份，使用打包运行时生成最终 Cordis 配置，并启动隔离的 Web 后端。缺少必需 Cordis 配置项或必需 Client bundle 时，构建直接失败。它还会通过已部署的 HTTP API 创建一个空白会话且不发送模型请求，以证明 Profile 没有用重复的核心包覆盖 Runtime 所有的作用域服务。验证结束后清理临时后端和文件。

必需集合包括 Workspace Lineage、Better Sidebar、Cowork、Message Edit 和 File Edit。Cowork 只包含 Host；其余四个插件还必须出现在 Web 启动 manifest 中。

Electron Builder 配置会显式固定 desktop App 目录。在 pnpm 工作区中，这会阻止 Builder 的元数据注入向上找到并改写统一工程根的包清单。候选打包会验证根清单保持不变。

安装脚本只消费 `desktop/dist/stable/mac-arm64/DeepSeek Harness.app`。Dev 候选绝不会成为安装输入。脚本会将现有应用保留在固定的 `.previous.app` 路径，且当既有备份存在时拒绝替换。

## Alternatives considered

**只检查 `node_modules`。** 这种检查只能证明包已安装，无法发现 Cordis 组合或 Client 发现缺失。

**在 Profile 中安装 Harness 核心 peer 包。** Profile 本地副本可能与 Runtime 副本同时加载，并把作用域所有权拆到不同模块实例中，使会话创建在组合表面正常时仍然失败。因此 Profile 插件通过启动器维护的 fallback 解析 Runtime 所有的 peer 包。

**将开发者的 Stable Profile 用作发行模板。** 这种方式会掩盖产品声明缺失，并可能把个人插件、路径、状态或凭据复制进 App。

**只依赖人工 UI 测试。** 人工测试仍用于验证产品行为，但它发生较晚，也容易被遗漏，不适合作为唯一打包保护措施。

## Consequences

桌面打包会额外执行一次隔离后端启动和压缩包解压。任何必需定制插件没有进入实际运行 composition 时，Dev 或 Stable 候选都无法生成。用户数据和已安装的 Stable App 不作为验证输入。

桌面打包也会将源码元数据排除在产物写入范围之外。若一次打包修改了统一工程根的 `package.json`，该次构建即为失败，必须先恢复文件并修正配置后才能接受下一份候选。

Stable 安装仍是候选验证之后的显式操作，且不会复制或重置用户数据。
