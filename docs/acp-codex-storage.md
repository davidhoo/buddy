# ACP Codex 会话隔离

Buddy 默认将 `codex` 和 `wecode_codex` 的 ACP 会话分别存放在
`<dataRoot>/acp/<actor>/codex-home/`。正式运行、健康检查、模型探测、启动器测试和提交信息生成均使用这个持久目录。

- `CODEX_HOME` 隔离会话文件；`CODEX_SQLITE_HOME` 和启动参数 `-c sqlite_home=...` 隔离索引，防止继承的桌面环境或配置把索引写回桌面 Codex。
- 首次使用时，从继承的 `CODEX_HOME`（默认 `~/.codex`）复制配置与全局 AGENTS 指令。副本权限为 `0600`，WeCode 对配置的修改不会回写原文件。skills、rules 链接回原目录以保留相对资源。
- `auth.json` 不再复制快照，而是以符号链接指向桌面目录中的同一份文件。Codex 每次刷新都会轮换 OAuth refresh token：两份副本各自刷新会互相作废，旧副本随后报 `refresh_token_reused`，codex-acp 将其呈现为 `ACP Error -32000: Authentication required`。共享同一文件后只有一条 token 链，任一侧刷新都立即对另一侧生效。
- 升级时仅当双方均为 OAuth/ChatGPT 认证、账号 ID 均非空且一致、且私有副本的 `last_refresh` 有效并严格晚于桌面凭据时，才把私有内容写回桌面再建立链接。桌面为 API Key、认证类型不同、账号或刷新时间缺失/无效/相等时，一律保留桌面凭据并链接到桌面文件，避免旧 OAuth 副本覆盖用户当前登录。缺少 `auth_mode` 的旧版文件按凭据结构推断，缺失字段不视为匹配。
- 若文件系统不支持符号链接，退化为每次 ACP 运行前同步最新快照。
- 旧任务续聊时，只复制所选 ID 对应的 rollout；已有私有 rollout 不会被旧版本覆盖。不会复制公共数据库、删除原记录或迁移其他任务。
- 显式填写 launcher 的 `CODEX_HOME` / `CODEX_SQLITE_HOME` 时尊重用户设置；指回桌面目录就会重新共享历史。自定义 `CODEX_PATH` 仍作为底层可执行文件调用。

## 认证失效后的恢复

历史版本留下的副本若已被轮换作废，Buddy 会在下次 ACP 运行前完成迁移，但失效的 refresh token 无法自动复活，需要重新登录一次：

```bash
codex login
```

登录状态写入 `~/.codex/auth.json`，Buddy 的 ACP 目录通过符号链接直接读取，无需对私有目录单独登录。可用 `codex login status` 确认。

此变更针对 ACP 通道，不改变 CLI 通道。已出现在桌面 Codex 的旧条目不会自动消失；确认不再需要桌面显示后可单独归档，原始会话不应直接删除。它们在桌面端恢复时仍可能因缺少 `wecode_openai` provider 失败；这不代表 Buddy 中的会话文件丢失。
