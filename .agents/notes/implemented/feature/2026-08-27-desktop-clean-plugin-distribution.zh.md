# Agent Note: 桌面分享包初始化干净插件 Profile

Status: implemented

[English](2026-08-27-desktop-clean-plugin-distribution.md) | 中文

## 问题

桌面安装包内置 Harness 运行时，但本机安装的定制插件位于用户 Web profile。只复制 App 会遗漏这些插件，复制现有 profile 则会暴露会话、设置、状态、凭据、工作区引用、本机路径和开发软链接。

## 决策

桌面构建根据 `distribution/profile-manifest.json` 中的产品白名单、`plugins/` 下维护的产品插件和固定 Harness 工作区包生成独立的干净 Profile 压缩包，构建过程不读取已安装的 Stable Profile。本地开发链接通过 npm 包内容转为实体文件，生成代码注释中的本机路径会被清除，生成的 Profile 使用空根配置和声明的产品组成。Runtime 安装阶段使用本地包压缩文件，但归档清单会被改写为只含版本号的依赖。源码隐私检查覆盖已跟踪文件和未被忽略的未跟踪文件；最终发行检查会解压 Runtime、Profile 和 Electron 应用归档，并拒绝个人状态、构建机路径、私钥文件和绝对软链接。

打包后的 App 首次启动时，Electron 会在 `profiles/web` 不存在时解压该快照，并在相邻位置记录内置 Profile 标识。Dev 构建的标识发生变化时，会先暂存并校验新归档，再将旧 Profile 移入可恢复备份，然后原子提交替换内容与标识；提交失败会恢复备份。Stable 使用[产品模块合并决策](../bug-fix/2026-09-01-stable-product-profile-merge.md)，保留用户组成和额外插件。Runtime 与 Profile 仍分开解压；替换 Profile 不会触碰凭据、会话、工作区、设置、审核状态、Explorer 状态或其他 Harness 持久数据。

## 考虑过的替代方案

**只压缩当前安装的 App。** 接收者只能得到桌面壳和核心运行时，无法得到由本地 profile 解析的定制插件。

**复制完整应用支持目录。** 这能保留完全相同的本地状态，但会泄露用户记录，并让接收者依赖本机专属路径。

**要求接收者手动安装所有插件。** 这样能减小 App，但不能交付分享包需要复现的 Harness 使用体验。

**永远不替换已有 Dev Profile。** 这样可以保留 Dev Profile 内的任意手工改动，但替换构建仍会运行过期产品插件，导致新打包的设置和界面持续缺失。Dev 因此将内置 Profile 视为产品维护内容；Stable 通过产品模块合并保留用户组成。

## 后果

分享包会因包含插件代码和必要生产依赖而变大。接收者获得选定插件组成，但会话、工作区状态、设置、凭据和日志均为空。替换 Dev 构建会更新产品插件并保留 Dev 用户数据；Dev 生成 Profile 内的手工改动会被有意替换。Stable 会替换包内产品模块，同时保留用户编写的组成和额外模块。使用空环境进行干净启动，验证 Profile 不依赖源机器也能加载；[运行时插件验证决策](../process/2026-09-01-desktop-profile-runtime-verification.md)会拒绝缺少必需 Host 或 Client 组成的候选包。
