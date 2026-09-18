# ACP Codex 会话隔离

Buddy 默认将 `codex` 和 `wecode_codex` 的 ACP 会话分别存放在
`<dataRoot>/acp/<actor>/codex-home/`。正式运行、健康检查、模型探测、启动器测试和提交信息生成均使用这个持久目录。

- `CODEX_HOME` 隔离会话文件；`CODEX_SQLITE_HOME` 和启动参数 `-c sqlite_home=...` 隔离索引，防止继承的桌面环境或配置把索引写回桌面 Codex。
- 首次使用时，从继承的 `CODEX_HOME`（默认 `~/.codex`）复制配置、文件式认证及全局 AGENTS 指令。副本权限为 `0600`，WeCode 对配置的修改不会回写原文件。skills、rules 链接回原目录以保留相对资源。
- 配置与认证是初始副本，后续不自动覆盖私有修改；若以后切换登录或配置，需同步到对应私有目录。系统钥匙串认证仍由 Codex 自身处理。
- 旧任务续聊时，只复制所选 ID 对应的 rollout；已有私有 rollout 不会被旧版本覆盖。不会复制公共数据库、删除原记录或迁移其他任务。
- 显式填写 launcher 的 `CODEX_HOME` / `CODEX_SQLITE_HOME` 时尊重用户设置；指回桌面目录就会重新共享历史。自定义 `CODEX_PATH` 仍作为底层可执行文件调用。

此变更针对 ACP 通道，不改变 CLI 通道。已出现在桌面 Codex 的旧条目不会自动消失；确认不再需要桌面显示后可单独归档，原始会话不应直接删除。它们在桌面端恢复时仍可能因缺少 `wecode_openai` provider 失败；这不代表 Buddy 中的会话文件丢失。
