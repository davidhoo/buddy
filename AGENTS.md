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

## Cursor Cloud specific instructions

This is a macOS-first Electron app, but dev/test/build all run on the Linux Cloud VM. Commands are in the `## Commands` section above and `package.json`. Notes specific to running here:

- **Running the GUI (`pnpm dev`)**: Electron needs a display. A virtual display is available on `DISPLAY=:1`, and the app must run without the Chrome sandbox. Launch with `DISPLAY=:1 ELECTRON_DISABLE_SANDBOX=1 pnpm dev`. The `Failed to connect to the bus` / GPU-process / `APPIMAGE env is not defined` messages in the log are harmless in this headless container — the window still renders. The renderer dev server also serves standalone on `http://localhost:5173/`.
- **AI actor CLIs are not installed** (`claude`, `codex`, `opencode`, `kimi`, `cursor-agent`). Creating a task works and persists to disk, but starting/running a task fails its connectivity health check and lands the task in `FAILED` (e.g. `Command 'claude' not found`). This is expected — end-to-end actor runs require installing and authenticating one of those external CLIs.
- **Running the Cursor Agent backend end-to-end** (verified working here): (1) Install the CLI with `curl https://cursor.com/install -fsS | bash` — it lands in `~/.local/bin` as both `agent` and `cursor-agent`. (2) `fixShellPath()` only augments PATH on macOS, so on Linux the Electron process only finds the CLI if you launch `pnpm dev` from a shell that has `~/.local/bin` on `PATH` (or set the launcher `command` to the absolute path `/home/ubuntu/.local/bin/cursor-agent`). (3) Auth is via the `CURSOR_API_KEY` env var (a user secret); it must be present in the environment **before** the app is launched, since child CLIs inherit the Electron process env. `cursor-agent status` printing "Not logged in" is a red herring — API-key env auth still works for headless `-p` runs. (4) To run two Cursor actors with different models, add launcher profiles in `~/Library/Application Support/buddy/global/settings.json` (e.g. `cursor-agent` and `cursor-agent-2`), each with `backend: "cursor"`, a `model` (see `cursor-agent --list-models`, e.g. `gpt-5.6-sol-high`, `claude-opus-4-8-thinking-high`), and `cursor: { force: true, trust: true }`; then pick them as implementer/reviewer in the New Task modal (the modal lists any launcher whose `backend` is set). Restart the app after editing global settings so the renderer reloads them.
- **Data root**: On Linux the hardcoded macOS path resolves to `~/Library/Application Support/buddy/` (i.e. `/home/ubuntu/Library/Application Support/buddy/`); tasks/workspaces are written there.
- **E2E tests (`pnpm test:e2e`)**: Requires Playwright browsers (`pnpm exec playwright install chromium`). The script starts a Vite server on `127.0.0.1:5173` and runs Playwright against a mocked `window.buddy`/`window.api` (no Electron). Note: a few of these specs are currently stale relative to the UI (strict-mode selector violations, e.g. the `新建任务` text matching two buttons) and fail independent of environment setup.
- **No lint command exists** — there is no ESLint/Prettier config. Use `pnpm typecheck` and `pnpm test` for verification. Packaging (`pnpm dist` / `release:signed`) is macOS-only and will not work here.
