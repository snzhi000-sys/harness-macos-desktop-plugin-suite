# Agent Note: 将包内产品模块合并进 Stable 用户 Profile

Status: implemented

[English](2026-09-01-stable-product-profile-merge.md) | 中文

## Problem

Stable 用户会在长期使用的应用环境中保留凭据、会话、自定义 patch 和额外插件。完全不触碰 Web Profile 虽然能保留定制，但替换 App 后仍会继续运行过期产品模块，导致包内修复和设置项缺失。

## Decision

桌面引导程序会在 `profiles/web` 相邻位置记录包内 Profile 标识。Stable 包携带不同标识时，会解压并校验干净产品 Profile，把现有 Stable Profile 复制到暂存目录，再只递归叠加包内 `node_modules` 条目。现有 `package.json`、`cordis.yml`、`cordis.patch.yml`、额外模块以及 Profile 之外的全部数据保持不变。程序通过可恢复备份原子切换到合并暂存副本，失败时恢复旧 Profile。标识相同则跳过解压与合并。

## Alternatives considered

**替换完整 Stable Profile。** 否决，因为这会删除用户的 bundle 列表、patch 和第三方插件。

**永远不更新 Stable Profile 内容。** 否决，因为替换 App 后会继续运行过期产品模块，遗漏包内产品行为。

**直接从源码工作区加载产品插件。** 否决，因为安装后的 App 必须自包含，不能依赖开发者检出目录。

## Verification

Desktop 测试证明合并会替换产品模块，同时保留用户组成、patch、个人插件、凭据和会话。Profile Runtime 验证器继续在 Electron 打包前证明干净包内组成可用。

## Consequences

替换 Stable App 可以更新包内产品插件，而不重置 Key、会话、状态或用户插件组成。与包内依赖同名的额外插件会被视为产品所有并被替换。用户在 Stable Profile 内手工执行包管理操作仍可能改写已安装模块，需要下一个包内标识再次修复。
