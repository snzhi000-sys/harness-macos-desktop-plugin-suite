# Agent Note: 扩展 Provider 设置与 DeepSeek 诊断

Status: implemented

[English](2026-09-04-stage-7-provider-extensions-and-deepseek-diagnostics.md) | 中文

## 问题

Provider 登录控件缺少由插件扩展模型设置页的稳定位置，模型发现不会复用已配置的 Profile header，DeepSeek 请求也无法上报经过隐私约束的已启用插件包清单。如果没有稳定扩展点，这些需求会迫使 Better Sidebar 拥有无关设置，并可能泄露本地路径或配置。

## 决策

- 模型设置区继续拥有页面，开放按 `settingsNs` keyed 的 `settings.models.provider-card` 与 `settings.models.footer`；认证插件通过现有槽位生命周期扩展这些 seat。
- Provider-card owner facts 仅包含提供方目录 entry 以及 `configured`、`keyConfigured` 布尔值。
- 模型发现搜索不区分大小写地匹配 id 和显示名称；批量切换只影响可见结果。
- Host 侧 pi-ai 发现复用已配置 Profile header。临时输入凭据覆盖已保存凭据；Harness 控制的 `Accept` 和归因 header 在合并后拥有最终值。浏览器发现不接收 Profile header。
- DeepSeek 请求元数据使用每个字段仅一个所有者的通用 Registry。准备过程可取消并且发生在 fetch 前；HTTP 2xx 触发幂等的联合确认事务。
- 基础 composition 通过 `dsh_plugin_packages` 上报活跃且具有 package 身份的插件。Payload 只含包名与版本，稳定排序并去重，而且可以关闭。

## 兼容边界

- 现有 `settings.section`、LLM 发现、Session、附件、重试和插件可见接口保持不变。
- DeepSeek 思考历史与多模态／Files retry 保留在现有适配器中；扩展字段仅在序列化后合并，并在有界的过期 file-id retry 中保持不变。
- 本地路径、用户插件配置、工作区信息、Profile 内容和 manifest 额外字段都不会进入诊断 payload。
- Better Sidebar 不拥有新的设置扩展点。

## 考虑过的替代方案

**让 Better Sidebar 拥有 Provider 设置。** 未采用，因为模型配置是共享 Client 能力，不能依赖该产品插件才能使用。

**发送完整插件 manifest 或 Profile 配置。** 未采用，因为诊断只需要包身份；本地路径、用户配置、工作区信息与 manifest 额外字段都是不必要披露。

**在浏览器侧携带 Profile header 发现模型。** 未采用，因为凭据与已配置路由 header 属于 Host 边界。

## 验证

- 受影响 TypeScript project reference 构建成功。
- 不依赖网络监听的定向测试通过，共 5 个文件、184 项；另有 4 项 fetch stub 发现测试通过。
- 标准 Dev 构建已经重建 Host／Client、两个新包和所有产品插件，随后在相同的沙箱限制处停止：4 项 Better Sidebar 媒体 Range 测试收到 `listen EPERM`，其余 543 项插件测试通过。没有生成或发布 Electron 候选。

## 结果

认证插件可以在不改变 Models 页面所有者的情况下扩展该页面，模型发现遵循 Host Profile 路由，可选 DeepSeek 诊断只暴露排序后的包名与版本。新增 Registry 与确认事务带来生命周期和测试责任，但现有 Session、附件、重试与设置契约保持不变。
