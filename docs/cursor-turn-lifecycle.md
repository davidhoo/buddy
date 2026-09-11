# Cursor 回合与后台服务

## 问题

Cursor CLI 的 headless 模式默认会在模型回合结束后继续等待后台 shell。若 shell 运行的是常驻 Worker 或开发服务器，CLI 就迟迟不输出最终 `result`、也不退出，Buddy 因而无法交接下一轮。

此前 Buddy 超时后还会把全部 stdout 和提取出的任务内容拿来匹配升级关键词。工具输出里的“已更新”、提示词里的“自动升级”都可能触发错误的升级重试。

## 修复行为

- 原生 Cursor 的新会话和恢复会话都加上 `--single-turn`。Buddy 负责后续回合，Cursor 不再等待后台 shell 或自动追加的普通回合；CLI 定义仍保留对子代理的等待。
- 仍要求进程成功退出且存在非空的 `result.success`；不会把流式 assistant 文本当成回合完成。
- Cursor 每轮提示明确要求：有限的测试、构建、迁移必须执行完并读取结果；需要跨轮保留的服务应由项目服务管理器启动，或使用独立系统会话，并断开 stdin、重定向 stdout/stderr。交接时提供 PID、日志路径和停止命令。
- pipe、PTY 启动器单独返回 `timedOut`。实际任务和连通性检查遇到超时都报告明确的超时错误，不进入升级重试或会话重置；即使子进程捕获 SIGTERM 后返回 0，也不当成成功。
- 升级检测只检查 CLI 的纯文本诊断，跳过 JSON 事件及截断的 NDJSON，不再重新扫描提取出的任务回复。保留 wecode 等 CLI 在 stdout/stderr 打印升级提示后退出的重试能力。

## 后台服务注意事项

`--single-turn` 不是“保留全部后台 shell”的开关。Cursor 退出时会清理它仍持有的 shell。实测单用 `nohup ... &` 也不能确保服务存活。

本机验证可用的启动方式：

```python
import subprocess

with open("worker.log", "ab") as log:
    process = subprocess.Popen(
        ["sh", "worker.sh"],
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    print(process.pid)
```

将这个短启动器作为普通有限 shell 命令运行。命令、工作目录和日志路径由具体项目决定，先检查是否已有服务，随后验证启动状态。Buddy 不会自动将任意已有后台进程迁移成独立服务；服务能否跨轮保留仍取决于正确的启动方式。

## 验证记录

2026-09-11，macOS，Cursor CLI `2026.09.08-6caf4ff`：

| 场景 | 实测结果 |
| --- | --- |
| `--single-turn` + CLI 管理的后台 shell | 20.72 秒成功退出，但 shell 被终止，因此不能只加参数 |
| `--single-turn` + `nohup ... &` | 23.50 秒成功退出，Worker 未存活，不能作为保留服务方案 |
| `--single-turn` + 独立系统会话 | 18.10 秒成功退出，Worker 仍存活，随后自行完成 60 秒任务 |
| 修改后的 BuddyRunner + 真实 Cursor | 26.23 秒完成第 1 轮，记录一次 `actor.completed`，`active_run=null`，`next_actor=codex`；按测试设置的 1 轮上限暂停，交接时 Worker 仍存活 |

回归检查：67 个测试文件、648 个单元测试全部通过，TypeScript 类型检查及 main/preload/renderer 构建通过。覆盖超时后返回 0、任务内容中的升级关键词、真正升级提示、缺失 Cursor result、用户中断、连通性超时和 PTY 超时。

测试在独立 worktree 和临时数据目录中完成，没有恢复或停止用户已有的 Buddy/Cursor 会话。未对现有 DeepWave 任务重跑，也未验证其他 Cursor 版本或实际委派子代理场景。`--single-turn` 是该版本隐藏参数；旧版不支持时应升级 CLI，不能静默去掉参数后重新引入无限等待。

复验命令（使用当前安装的依赖，与 package scripts 等价）：

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run tests/unit
node node_modules/electron-vite/bin/electron-vite.js build
```
