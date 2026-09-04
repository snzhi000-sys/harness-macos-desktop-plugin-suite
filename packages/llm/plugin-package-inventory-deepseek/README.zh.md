# @deepseek-ai/dsh-plugin-package-inventory-deepseek

[English](README.md) | 中文

可选的 DeepSeek 请求诊断插件，通过请求扩展 Registry 上报活跃且由 Loader 装载的插件包。

协议字段为第 1 版 `dsh_plugin_packages`。它包含稳定排序、去重后的 `{name, version}` 列表，来源为活跃的 Host package entry 与常驻 Agent preset entry。禁用、等待、失败、分组、松散文件、URL 与 Cordis builtin entry 均不计入。

只有包名和版本会离开 Host。本地模块路径、用户插件配置、工作区信息、Profile 内容以及 package manifest 中的其他字段都不会包含。上报默认启用，可通过 `enabled: false` 关闭。

## 模型体验

### 插件包清单

#### 模型看到什么

Prompt、消息、工具和工具结果都不会增加内容。该清单属于面向提供方的诊断元数据。

#### Token 影响

不会增加模型可见 token。

#### KV Cache 影响

模型可见前缀不变。提供方是否按该诊断字段做统计或缓存划分由提供方自行定义。

## 已知限制与暂缓事项

- 身份解析会在请求准备期间读取 package manifest，并在插件生命周期内缓存身份；当前没有单独维护 Loader epoch cache。
- 没有有效 package 身份的 entry 会根据其属于松散模块还是 malformed package manifest 而被省略或导致准备失败。
