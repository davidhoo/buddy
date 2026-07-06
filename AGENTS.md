# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

Buddy is a macOS Electron app that orchestrates **dual-AI-agent collaborative coding**. Two AI actors (implementer + reviewer) take turns on a task, with a configurable countdown between rounds for human intervention. The loop ends when both actors confirm "break" (dual-break). Supported actors: Codex, Codex, OpenCode, Kimi.

This is a TypeScript rewrite of a Python predecessor. Data directories (`~/Library/Application Support/buddy/`) are compatible between both versions.

## Commands

```bash
pnpm dev                    # Dev mode with HMR
pnpm build                  # Compile all three targets (main/preload/renderer)
pnpm test                   # Unit tests (vitest run tests/unit)
pnpm vitest run tests/unit/main/buddy-store.test.ts  # Single test file
pnpm test:e2e               # E2E tests (Playwright)
pnpm typecheck              # tsc --noEmit
pnpm dist                   # Build + unsigned DMG
pnpm release:signed         # Build + sign + notarize (needs CSC_NAME env)
```

## Architecture

**Three-process Electron** (main / preload / renderer), built with electron-vite.

### Main process → Renderer communication

- **Request-response**: `ipcMain.handle('buddy:xxx')` ↔ `ipcRenderer.invoke('buddy:xxx')`. All buddy operations use `buddy:*` channel naming.
- **Push events**: Main pushes to renderer via `webContents.send('buddy:event', ...)`. The `BuddyEventBus` in main publishes; preload subscribes via `ipcRenderer.on`.

### Core: BuddyCoreService → BuddyStore + BuddyRunner + BuddyEventBus

`src/main/buddy/service.ts` composes three modules:
- **Store** (`store.ts`): Filesystem persistence. All JSON writes are atomic (write `.tmp`, then `rename`). Zod validates on read, not write, for forward compatibility.
- **Runner** (`runner.ts`): Spawns actor CLIs, manages the task state machine, parses streaming output.
- **EventBus** (`events.ts`): Pub/sub for task lifecycle events.

### Task state machine

```
READY → RUNNING_{ACTOR} → COUNTDOWN → (READY | PAUSED | DONE)
                                 ↓
                              FAILED (recoverable)
                                 ↓
                              PAUSED
```

- **COUNTDOWN**: Pause between rounds (default 30s) for human review. Renderer-side timer auto-skips when deadline elapses.
- **Dual-break**: Both actors must signal `type=break` for task to reach DONE. Tracked via `pending_break` in state.
- **Recovery**: On app restart, tasks stuck in `RUNNING_*` are reset to `PAUSED`.

### Actor launcher system (`launchers.ts`)

Detects whether a command is a "native" CLI (Codex/codex/opencode/kimi) or a generic "contract" command. Native launchers use CLI-specific flags (e.g., `Codex -p --output-format stream-json`). Contract launchers pass `BUDDY_ACTOR`, `BUDDY_MODE` env vars. Session resumption uses `--resume` (Codex), `resume` (Codex), `--session` (OpenCode/Kimi).

### Data model (filesystem, no database)

- Workspaces keyed by repo path hash
- Per-task directory: `state.json`, `settings.json`, `task.md`, `context.md`, `events.jsonl`, `transcript.jsonl`, `artifacts/`, `rounds/`
- Global settings: `dataRoot/global/settings.json`

### Renderer

- React 18 + TanStack React Query 5. Components in `src/renderer/components/`, hooks in `hooks/`.
- Preload exposes `window.api` (system ops) and `window.buddy` (all buddy operations) via contextBridge.
- 23 preset themes (CSS custom properties), i18n (zh-CN/zh-TW/en with CJK auto-detect).
- `@` alias maps to `src/renderer` (renderer only; main process uses relative paths).

## Conventions

- **Icons**: Use lucide-react. Do not introduce other icon libraries or custom SVGs.
- **Atomic writes**: Always write JSON via `.tmp` → `rename`, never direct write.
- **Zod schemas**: Define in `src/main/buddy/schemas.ts`. Validate on read, not write.
- **Sensitive data**: API keys are automatically redacted from event logs by `redact.ts`.
- **i18n**: UI text goes through `useI18n` hook. Prompt builder detects human language and instructs actors to reply in the same language.
