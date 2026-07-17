# Cursor Agent backend

## Buddy 如何协调 agent

Buddy 不让两个 CLI 直接互相通信。主进程 `BuddyRunner` 是唯一协调者：

1. 根据任务的 `implementer_actor` / `reviewer_actor` 选出本轮 agent。
2. `buildActorPrompt` 将任务、背景、最近 transcript、角色指令和 Buddy 消息协议组装成 prompt。
3. launcher 以无头模式启动对应 CLI，并把流式事件统一解析成文本、工具调用和 session ID。
4. agent 的最终文本必须是 `{ "type": "chat" | "break", "content": "..." }`。
5. `chat` 会把控制权交给另一个 agent；连续两个不同 agent 的 `break` 才会结束任务。
6. transcript、状态、原始事件和 prompt artifact 都写入任务目录；应用重启后可用 session ID 续接。

因此，后端只需要实现三件事：无头执行、结构化输出、会话续接。Cursor Agent CLI 分别通过
`-p --output-format stream-json`、NDJSON 事件和 `--resume <session-id>` 满足这些要求。

## 可命名的 agent profile

`launchers` 的 key 是稳定的 profile ID，而不是后端类型。默认提供 `cursor-agent`，设置页可继续
添加 `cursor-agent-2`、`cursor-agent-3` 等 profile。每个 profile 独立保存：

- 显示名称和 CLI 命令（`agent` / `cursor-agent`）
- 模型 ID
- prompt preset 和 profile 专用 prompt
- Agent / Plan / Ask 模式
- `--force`、`--trust`、`--approve-mcps`
- sandbox 模式、partial stream 和额外 CLI 参数
- 环境变量与超时
- 可续接 session ID

任务仍保持“执行者 + 审查者”的双 agent 状态机，但两者可以同时选择 Cursor backend 的不同
profile，并分别使用不同模型。

示例持久化配置：

```json
{
  "launchers": {
    "cursor-agent": {
      "command": "agent",
      "backend": "cursor",
      "display_name": "Cursor Implementer",
      "model": "composer-2.5",
      "prompt_preset_id": "implementation",
      "env": {},
      "timeout_seconds": 7200,
      "cursor": {
        "mode": "agent",
        "force": true,
        "trust": true,
        "sandbox": "default"
      }
    },
    "cursor-agent-2": {
      "command": "agent",
      "backend": "cursor",
      "display_name": "Cursor Reviewer",
      "model": "gpt-5.6-sol-high",
      "custom_prompt": "只报告会阻塞合并的问题。",
      "env": {},
      "timeout_seconds": 7200,
      "cursor": {
        "mode": "agent",
        "force": true,
        "trust": true,
        "sandbox": "enabled"
      }
    }
  }
}
```

## 模型发现

Cursor 官方 TypeScript SDK 的 `Cursor.models.list()` 提供模型、参数和 variants，但当前
`@cursor/sdk` 要求 Node.js 22.13+；Buddy 使用的 Electron 33 内置 Node.js 20.18，直接加载 SDK
会导致生产运行时不兼容。

Buddy 因此调用 SDK 所使用的同一个官方模型目录接口 `GET https://api.cursor.com/v1/models`。
当 profile 环境中有 `CURSOR_API_KEY` 时，可获得与 SDK 相同的结构化模型、参数和 variants。
没有 API key 或接口失败时，降级到当前登录账户的 `agent --list-models`。CLI 降级仍可选择模型，
但只提供 ID 和显示名称。

模型目录不会硬编码；设置页的“获取模型”按钮按需刷新。留空模型时使用 Cursor 账户默认模型。

## 兼容性

- 原有 Claude Code、Codex、OpenCode、Kimi launcher 和专用 session 字段保持不变。
- 新 profile session 写入 `state.agent_sessions[profileId]`；旧任务没有此字段时会自动使用空 map。
- 新字段均为可选字段，旧 `settings.json` / `state.json` 仍能读取。
- 原始 Cursor NDJSON 保存在 `artifacts/*-events.jsonl`，模型和耗时可进入 round stats。
