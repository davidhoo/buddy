# buddy-macos Native Buddy Core Design

## Decision

buddy-macos will own the Buddy runtime inside the Electron app. The app will no longer start or call `buddy-python`, and it will no longer route renderer requests through a local HTTP server.

The runtime target is:

```text
React renderer
  -> preload IPC bridge
  -> Electron main process
  -> TypeScript Buddy Core
  -> local files and actor CLI child processes
```

The renderer stays presentation-only. All filesystem access, task state transitions, countdown timers, process management, event persistence, and launcher execution live in the Electron main process.

## Goals

- Remove the `buddy serve` runtime dependency.
- Remove the `http://127.0.0.1:8765` API proxy.
- Keep the renderer API shape close to the current task API so UI migration stays small.
- Keep file formats compatible with existing Buddy data where practical.
- Make task execution resumable and auditable without requiring Python.
- Keep local capabilities behind a narrow preload IPC bridge.

## Non-Goals

- Do not embed a Python interpreter.
- Do not ship `buddy-python` as a sidecar executable.
- Do not introduce a replacement local HTTP server.
- Do not move privileged filesystem or process APIs into the renderer.
- Do not rewrite the UI as part of the backend migration except where the API boundary requires it.

## Architecture

```text
src/main/
  index.ts
  window-manager.ts
  ipc/
    buddy-handlers.ts
  buddy/
    service.ts
    store.ts
    paths.ts
    schemas.ts
    runner.ts
    countdown.ts
    launchers.ts
    parsers.ts
    protocol.ts
    prompts.ts
    events.ts
    locks.ts
    settings.ts
    redact.ts
    errors.ts

src/preload/
  index.ts

src/renderer/
  lib/api.ts
```

### IPC Boundary

The preload bridge exposes a narrow `window.buddy` API:

```ts
window.buddy = {
  checkHealth(),
  bootstrap(),
  getTasks(),
  getTaskDetail(taskId, workspaceKey),
  createTask(input),
  deleteTask(taskId, workspaceKey),
  startTask(taskId, input),
  sendMessage(taskId, input),
  skipCountdown(taskId, input),
  pauseCountdown(taskId, input),
  interrupt(taskId, workspaceKey),
  getEvents(taskId, since, workspaceKey),
  updateGlobalSettings(settings),
  onTaskEvent(callback)
}
```

`src/renderer/lib/api.ts` becomes a thin wrapper around `window.buddy`. React Query hooks can keep their current calling style.

### Main Process Service

`BuddyCoreService` replaces the current HTTP-oriented `BuddyService`. It coordinates store, runner, launchers, and events:

```ts
class BuddyCoreService {
  checkHealth(): Promise<HealthResponse>
  bootstrap(): Promise<BootstrapResponse>
  getTasks(): Promise<Task[]>
  getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail>
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>
  deleteTask(taskId: string, workspaceKey?: string): Promise<void>
  startTask(taskId: string, input: StartTaskInput): Promise<{ run_id: string }>
  sendMessage(taskId: string, input: SendMessageInput): Promise<void>
  skipCountdown(taskId: string, input: CountdownInput): Promise<void>
  pauseCountdown(taskId: string, input: CountdownInput): Promise<void>
  interrupt(taskId: string, workspaceKey?: string): Promise<void>
  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }>
}
```

### Store

The store owns all reads and writes under the Buddy application data directory:

- `global/settings.json`
- `workspaces/{workspace_key}/workspace.json`
- `workspaces/{workspace_key}/tasks/{task_id}/settings.json`
- `workspaces/{workspace_key}/tasks/{task_id}/state.json`
- `workspaces/{workspace_key}/tasks/{task_id}/transcript.md`
- `workspaces/{workspace_key}/tasks/{task_id}/events.jsonl`
- `workspaces/{workspace_key}/tasks/{task_id}/artifacts/*`
- `runtime/tasks/*.lock`

Writes must be atomic: write to a temporary file, fsync when practical, then rename. JSON and JSONL boundaries are validated with Zod before state enters the service layer.

### Runner

The runner implements the Buddy state machine in TypeScript:

- `READY` starts the selected actor.
- `RUNNING_*` owns one child process and one run lock.
- Successful actor output appends transcript and events.
- One actor break sets `pending_break`.
- Two compatible break signals transition to `DONE`.
- Non-break completion enters `COUNTDOWN`.
- Countdown elapsed starts the next actor.
- `pause-countdown` returns to `READY` with paused countdown metadata.
- `skip-countdown` starts the next actor immediately.
- launcher or parser failure records `latest_failure` and transitions to `FAILED` or `PAUSED` according to failure policy.
- app restart with an active run marks the run interrupted, clears stale run locks, and leaves the task in a recoverable paused/failed state.

Runner methods never trust renderer-provided state. They reload state from disk under lock, validate transition legality, write the next state, append events, then publish updates through the in-process event bus.

### Launchers

Launchers use `child_process.spawn` with pipes for actor execution. PTY is not part of the v0.1 actor path because JSON stream parsing needs clean stdout/stderr separation.

Initial actor support:

- Claude
- Codex

Follow-up actor support:

- OpenCode
- Kimi

Each launcher receives:

- actor name
- repo root
- task directory
- run id
- generated prompt
- prior session/thread id when available
- configured command, environment, and timeout

Launcher output is written to artifact files and streamed to the parser. Sensitive content is redacted before persistent event writes.

### Parsers And Protocol

Parsers convert raw actor output into Buddy protocol events:

- Claude `stream-json`
- Codex JSON output
- Buddy message protocol blocks
- final session/thread id capture
- tool/result/status text extraction
- malformed JSON diagnostics

Raw output and parsed events are separated. UI transcript entries come from parsed Buddy protocol content, not from unfiltered raw terminal bytes.

### Event Delivery

The main process keeps an in-memory event bus for live UI updates and persists all task events to `events.jsonl`.

Renderer data flow:

- initial load via `bootstrap`, `getTasks`, and `getTaskDetail`
- live updates via `window.buddy.onTaskEvent`
- polling remains available as a fallback during migration

### Locks

Two lock types are used:

- `.buddy.lock` inside each task directory for short state and event writes.
- `runtime/tasks/{workspace_key}__{task_id}.lock` for actor run ownership.

The native runtime does not need to coordinate with a running Python server, but it still preserves lock files to guard multiple buddy-macos windows or future compatible tools.

### Error Handling

All IPC handlers return structured errors:

```ts
{
  code: string,
  message: string,
  details?: unknown,
  recoverable?: boolean
}
```

Important error classes:

- invalid input
- missing task
- invalid state transition
- locked task
- launcher unavailable
- launcher timeout
- actor non-zero exit
- parser failure
- filesystem permission failure
- schema incompatibility

Renderer copy should be user-facing, but raw diagnostic details stay available in logs and task events after redaction.

## Migration Plan

### Phase 1: Replace Renderer HTTP With IPC

- Add `window.buddy` preload API.
- Add main process IPC handlers.
- Change `src/renderer/lib/api.ts` to call IPC.
- Keep method names close to the current HTTP API.
- Remove `file:///api/*` proxy once all renderer calls use IPC.

### Phase 2: Native Read Model

- Implement paths, schemas, store reads, and event reads.
- Support `checkHealth`, `bootstrap`, `getTasks`, `getTaskDetail`, and `getEvents`.
- Validate against existing task data.

### Phase 3: Native Writes

- Implement task creation, deletion, and global settings updates.
- Add atomic writes and task write locks.
- Add tests for schema defaults and compatibility.

### Phase 4: Native Runner

- Implement state transitions, countdowns, pending break, failure recording, and recovery.
- Add unit tests for every legal transition.
- Add restart recovery tests for active runs.

### Phase 5: Native Launchers

- Implement Claude and Codex launchers with `spawn` pipes.
- Implement prompt generation and parser integration.
- Write artifacts and event JSONL.
- Add fixture-based parser tests.

### Phase 6: Remove Python And HTTP Runtime

- Delete `buddy serve` startup logic.
- Delete axios-based main service.
- Delete renderer HTTP proxy.
- Remove unused HTTP dependencies if no longer needed.
- Update package metadata and docs to describe native runtime.

## Testing Strategy

- Unit tests for path resolution, schema parsing, store reads/writes, and redaction.
- Runner tests for state transitions, countdown, break confirmation, interrupt, and failure policies.
- Parser fixture tests for Claude and Codex output.
- Compatibility fixture tests for existing Buddy data.
- IPC tests for handler validation and structured errors.
- E2E smoke test: create task, start actor with a fake launcher, stream events, countdown, continue, and complete.

## Risks

- State machine drift from the previous Python behavior.
- Actor CLI output changes breaking parsers.
- App restart while a child process is running.
- File locking behavior across multiple app instances.
- Sensitive output accidentally entering persistent logs.

The mitigation is to migrate in phases, keep fixtures close to real task directories, and test runner behavior independently from the UI.

## Acceptance Criteria

- The app starts and performs task CRUD without `buddy-python` installed.
- No renderer request is routed to `http://127.0.0.1:8765`.
- Starting a task spawns actor CLIs directly from the Electron main process.
- Task state, transcript, events, and artifacts persist under the Buddy data directory.
- Closing and reopening the app preserves task state.
- Claude/Codex smoke tests can complete an implement-review loop with no Python process.
- Existing UI workflows continue through the IPC-backed `api.ts` wrapper.
