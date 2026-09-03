# Agent Note: Projection cache 跨版本恢复

Status: implemented

[English](2026-09-03-projection-cache-cross-version-salvage.md) | 中文

## Problem

本地产品把所有 Session 投影检查点存储在 v3 `session_projcache.json` 单元中，而后续 Harness 版本使用 v4 和 v5 的逐 Session 文档。严格版本匹配的单文件读取器会拒绝升级后的用户目录，或丢弃全部仍有效的标题缓存。即使 Session 日志能够重建投影，一条 schema 无效的派生检查点也可能在启动期间拒绝整个领域。

## Decision

存储描述符支持可选的 `per-record` 布局，并显式声明当前所有者 schema 可接受的旧记录版本。单文件领域继续保持严格版本匹配。JSON 后端独立存储每条 per-record 值，在不删除旧文件的前提下导入版本受支持的旧单文件，每次新写入都使用当前版本，并把格式错误或版本不受支持的文档视为缺失。

领域层默认继续在校验失败时明确报错。只有可丢弃领域可以选择 `invalidRecords: 'backup-and-skip'`，且后端必须能够移走无效记录文档。备份失败仍会拒绝打开，因此恢复过程不会销毁唯一的诊断副本。

Session 投影缓存使用 v5 per-record 存储，接受 v3 和 v4 文档，并将当前写入绑定到 `createdAt`、`cwd`、是否由 seed 创建和继承事件数。缺少 lineage 字段表示未 seed 的旧记录；Fork 会拒绝该记录，并从权威 Session JSONL 重新折叠。

## Alternatives considered

**用上游 handle-based 设计替换完整 Session 持久化栈。** 不采用，因为投影兼容不要求改变 Session 事件存储、查询 API、插件可见接口或本地已验证的历史尾页缓存。

**版本变化时丢弃全部缓存。** 不采用，因为仍有效的旧标题和列表投影可以安全读取；强制每个 Session 冷折叠会增加启动成本，却不会保护更多数据。

**原地修复无效记录。** 不采用，因为缓存是派生数据，无法从失败的 schema 推断正确值。移走原始字节并从 Session 日志重建可以同时保留诊断信息与正确性。

**全局跳过无效的权威领域记录。** 不采用，因为只有明确声明为可丢弃的派生领域才能安全丢失单条记录。Workspace 等权威状态必须继续明确报错。

## Consequences

现有本地 v3 用户目录和上游 v4/v5 缓存介质可以由同一 Runtime 打开，后续写入会收敛为 v5 逐 Session 文档。只要无效检查点能够备份，单条 schema 错误不再阻断 Web 后端。未知版本保持不变，只读介质上的备份失败仍明确报错，主 Session JSONL 格式及全部插件 Session 接口均保持不变。
