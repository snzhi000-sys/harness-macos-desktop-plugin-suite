# dsh-lark-cli

[English](README.md) | 中文

`dsh-lark-cli` 只向模型提供一个结构化的 Host 工具 `lark_cli`。它使用参数数组执行固定、可信的 `lark-cli`，不会经过 Shell。

首版只开放选定的 `auth`、`docs`、`drive`、`wiki` 与 `markdown` 快捷命令。原始 `api`、配置或 Profile 修改、自更新、内嵌 Skill 读取、目录同步、剪贴板或 URL 摄取、调用方指定输出路径、后台进程和持久终端均不可用。普通的文档创建、更新、导入、上传和其他非破坏性写操作直接执行。删除、回滚、退出登录和移除访问权限等高风险操作必须取得 Harness 单次审批，未获授权时 fail closed。上传路径会经过 realpath 校验、规范化且必须位于当前工作区内；子进程只能写入 lark-cli 凭据或状态目录及独立临时目录。

工具输出有容量上限，并会脱敏访问令牌与刷新令牌。OAuth 的 `auth login --no-wait` 会保留短期 device code，因为官方两阶段流程随后需要通过 `auth login --device-code` 完成授权。

本插件不经过 Shell，也不能修改工作区文件。
