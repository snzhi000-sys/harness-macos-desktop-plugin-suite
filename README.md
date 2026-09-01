# Harness macOS Desktop & Plugin Suite

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 macOS 桌面定制客户端与插件套件。项目在 Harness 插件化基座之上提供原生桌面封装、自研文件与侧边栏能力，以及面向产品与轻度开发工作的定制体验。

> 本项目是社区第三方项目，并非 DeepSeek 官方产品。DeepSeek Harness 仍处于开发者预览阶段，上游可能包含兼容性破坏性变更。

## 工程组成

- 仓库根目录：DeepSeek Harness 核心及本项目必要定制。
- `desktop/`：Electron macOS 桌面端。
- `plugins/`：本项目维护的产品插件。
- `distribution/`：开发版与正式版的发行清单。

当前迁移过程与保护边界见 [统一工程迁移执行计划](docs/MIGRATION_PLAN.zh-CN.md)，实际完成情况见 [迁移状态](docs/migration/STATUS.zh-CN.md)。

## 产品开发命令

```bash
npm run product:build:plugins
npm run product:test:plugins
npm run product:test:desktop
npm run product:verify:privacy
npm run product:dist:dev
```

普通桌面构建默认生成 Dev App。Stable 候选只能显式运行 `npm run product:dist:stable`，安装正式 App 仍需要另外的明确授权。

## 上游 Harness

DeepSeek Harness (`dsh`) 是由 DeepSeek AI 开发的开源 Agent Harness，采用“一切皆插件”的架构并基于 Cordis。上游源码运行与贡献说明请参考：

- [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)
- [开发指南](docs/development.md)
- [架构文档](docs/architecture.md)
- [贡献指南](CONTRIBUTING.md)

## License

[MIT](LICENSE)。第三方依赖及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
