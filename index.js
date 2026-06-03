"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const node_os = require("node:os");
const node_path = require("node:path");
const node_crypto = require("node:crypto");
const promises = require("node:fs/promises");
const node_child_process = require("node:child_process");
const node_events = require("node:events");
const node_fs = require("node:fs");
const zod = require("zod");
class WindowManager {
  constructor() {
    this.mainWindow = null;
  }
  createWindow() {
    this.mainWindow = new electron.BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1e3,
      minHeight: 600,
      show: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 19 },
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        sandbox: false
      }
    });
    this.mainWindow.on("ready-to-show", () => {
      this.mainWindow?.show();
    });
    this.mainWindow.webContents.setWindowOpenHandler((details) => {
      electron.shell.openExternal(details.url);
      return { action: "deny" };
    });
    if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
      this.mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    } else {
      this.mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
    }
    this.mainWindow.on("enter-full-screen", () => {
      this.mainWindow?.webContents.send("window:fullScreenChange", true);
    });
    this.mainWindow.on("leave-full-screen", () => {
      this.mainWindow?.webContents.send("window:fullScreenChange", false);
    });
    return this.mainWindow;
  }
  getMainWindow() {
    return this.mainWindow;
  }
}
function registerBuddyHandlers(ipcMain, service) {
  ipcMain.handle("buddy:checkHealth", () => service.checkHealth());
  ipcMain.handle("buddy:bootstrap", () => service.bootstrap());
  ipcMain.handle("buddy:getTasks", () => service.getTasks());
  ipcMain.handle(
    "buddy:getTaskDetail",
    (_event, taskId, workspaceKey) => service.getTaskDetail(taskId, workspaceKey)
  );
  ipcMain.handle(
    "buddy:createTask",
    (_event, input) => service.createTask(input)
  );
  ipcMain.handle(
    "buddy:deleteTask",
    (_event, taskId, workspaceKey) => service.deleteTask(taskId, workspaceKey)
  );
  ipcMain.handle(
    "buddy:startTask",
    (_event, taskId, input) => service.startTask(taskId, input)
  );
  ipcMain.handle(
    "buddy:sendMessage",
    (_event, taskId, input) => service.sendMessage(taskId, input)
  );
  ipcMain.handle(
    "buddy:skipCountdown",
    (_event, taskId, input) => service.skipCountdown(taskId, input)
  );
  ipcMain.handle(
    "buddy:pauseCountdown",
    (_event, taskId, input) => service.pauseCountdown(taskId, input)
  );
  ipcMain.handle(
    "buddy:interrupt",
    (_event, taskId, workspaceKey) => service.interrupt(taskId, workspaceKey)
  );
  ipcMain.handle(
    "buddy:getEvents",
    (_event, taskId, since, workspaceKey) => service.getEvents(taskId, since, workspaceKey)
  );
  ipcMain.handle(
    "buddy:updateGlobalSettings",
    (_event, settings) => service.updateGlobalSettings(settings)
  );
}
function buildLauncherCommand(input) {
  let baseCmd = splitCommand(input.command);
  const kind = commandKindFor(input.actor, baseCmd);
  if (!baseCmd[0] && kind !== "contract") baseCmd = [input.actor];
  const [command, ...prefixArgs] = kind === "native_codex" ? cleanCodexBaseCommand(baseCmd) : baseCmd;
  if (kind === "native_claude") {
    return {
      command,
      args: [
        ...prefixArgs,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "text",
        ...input.sessionId ? ["--resume", input.sessionId] : []
      ],
      kind,
      stdinText: input.promptText
    };
  }
  if (kind === "native_codex") {
    const args2 = [
      ...prefixArgs,
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "--skip-git-repo-check"
    ];
    if (input.repoRoot) args2.push("-C", input.repoRoot);
    if (input.outputFile) args2.push("-o", input.outputFile);
    if (input.sessionId) args2.push("resume", input.sessionId);
    args2.push("-");
    return {
      command,
      args: args2,
      kind,
      stdinText: input.promptText
    };
  }
  if (kind === "native_opencode") {
    const args2 = [
      ...prefixArgs,
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions"
    ];
    if (input.sessionId) args2.push("--session", input.sessionId);
    const promptText = input.promptText?.trim();
    if (promptText) args2.push(promptText);
    return {
      command,
      args: args2,
      kind
    };
  }
  if (kind === "native_kimi") {
    return {
      command,
      args: [
        ...prefixArgs,
        "--print",
        "--output-format",
        "stream-json",
        "--input-format",
        "text",
        ...input.sessionId ? ["--session", input.sessionId] : []
      ],
      kind,
      stdinText: input.promptText
    };
  }
  const mode = input.mode ?? (input.sessionId ? "resume" : "start");
  const repoRoot = input.repoRoot ?? "";
  const taskDir2 = input.taskDir ?? "";
  const runId = input.runId ?? "";
  const outputFile = input.outputFile ?? "";
  const eventFile = input.eventFile ?? "";
  const env = {
    BUDDY_ACTOR: input.actor,
    BUDDY_MODE: mode,
    BUDDY_REPO_ROOT: repoRoot,
    BUDDY_TASK_DIR: taskDir2,
    BUDDY_RUN_ID: runId,
    BUDDY_PROMPT_FILE: input.promptFile,
    BUDDY_OUTPUT_FILE: outputFile,
    BUDDY_EVENT_FILE: eventFile,
    BUDDY_SESSION_ID: input.sessionId ?? ""
  };
  const args = [
    ...prefixArgs,
    "--actor",
    input.actor,
    "--mode",
    mode,
    "--repo-root",
    repoRoot,
    "--task-dir",
    taskDir2,
    "--run-id",
    runId,
    "--prompt-file",
    input.promptFile,
    "--output-file",
    outputFile,
    "--event-file",
    eventFile
  ];
  if (input.sessionId) args.push("--session-id", input.sessionId);
  return {
    command,
    args,
    env,
    kind
  };
}
function commandKindFor(actor, command) {
  const baseCmd = Array.isArray(command) ? command : splitCommand(command);
  const executable = node_path.basename(baseCmd[0] ?? "");
  if (actor === "claude" && (executable === "claude" || executable === "wecode")) return "native_claude";
  if (actor === "codex" && executable === "codex") return "native_codex";
  if (actor === "codex" && executable === "wecode" && baseCmd[1] === "codex") return "native_codex";
  if (actor === "opencode" && executable === "opencode") return "native_opencode";
  if (actor === "kimi" && executable === "kimi") return "native_kimi";
  if (executable === "" || executable === "wecode") {
    if (actor === "claude") return "native_claude";
    if (actor === "codex") return "native_codex";
    if (actor === "opencode") return "native_opencode";
    if (actor === "kimi") return "native_kimi";
  }
  return "contract";
}
async function runLauncher(input) {
  const [command, ...prefixArgs] = splitCommand(input.command);
  const child = node_child_process.spawn(command, [...prefixArgs, ...input.args], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStdout(line);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStderr(line);
  });
  child.stdin.end(input.stdinText ?? "");
  const timeout = setTimeout(() => child.kill("SIGTERM"), input.timeoutMs);
  const [exitCode] = await node_events.once(child, "exit");
  clearTimeout(timeout);
  return { exitCode };
}
function splitCommand(command) {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}
function cleanCodexBaseCommand(baseCmd) {
  const legacyBareFlags = /* @__PURE__ */ new Set(["--full-auto"]);
  return [baseCmd[0], ...baseCmd.slice(1).filter((part) => !legacyBareFlags.has(part))];
}
async function createRunLock(dataRoot, input) {
  const dir = node_path.join(dataRoot, "runtime", "tasks");
  await promises.mkdir(dir, { recursive: true });
  const path2 = node_path.join(dir, `${input.workspace_key}__${input.task_id}.lock`);
  await promises.writeFile(path2, JSON.stringify({
    ...input,
    app: "buddy",
    started_at: (/* @__PURE__ */ new Date()).toISOString()
  }));
  return path2;
}
async function removeRunLock(path2) {
  await promises.rm(path2, { force: true });
}
function parseClaudeStreamLine(line) {
  const json = JSON.parse(line);
  const text = Array.isArray(json.message?.content) ? json.message.content.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("") : void 0;
  return {
    text,
    sessionId: claudeSessionIdFromEvent(json),
    rawType: json.type
  };
}
function parseCodexJsonLine(line) {
  const json = JSON.parse(line);
  const itemText = json.item && typeof json.item === "object" && !Array.isArray(json.item) ? json.item.text : void 0;
  const text = Array.isArray(json.content) ? json.content.filter((part) => part.text).map((part) => part.text).join("") : typeof itemText === "string" ? itemText : json.message;
  return {
    text,
    sessionId: stableSessionIdFromEvent("codex", json),
    threadId: stableThreadIdFromEvent("codex", json) ?? textValue$1(json.thread_id),
    rawType: json.type
  };
}
function parseOpenCodeJsonLine(line) {
  const json = JSON.parse(line);
  const part = objectValue$1(json.part);
  const text = json.type === "text" ? textValue$1(part?.text) : json.type === "error" ? stringifyValue(json.error) : void 0;
  return {
    text,
    sessionId: stableSessionIdFromEvent("opencode", json) ?? textValue$1(json.sessionID),
    rawType: json.type
  };
}
function parseKimiJsonLine(line) {
  const json = JSON.parse(line);
  const text = json.role === "assistant" ? textValue$1(json.content) : void 0;
  return {
    text,
    sessionId: stableSessionIdFromEvent("kimi", json),
    rawType: json.type ?? json.role
  };
}
function parseActorLine(actor, line) {
  if (actor === "claude") return parseClaudeStreamLine(line);
  if (actor === "codex") return parseCodexJsonLine(line);
  if (actor === "opencode") return parseOpenCodeJsonLine(line);
  if (actor === "kimi") return parseKimiJsonLine(line);
  return parseCodexJsonLine(line);
}
function parseActorEvents(actor, rawEvents) {
  return rawEvents.split(/\r?\n/).flatMap((raw) => {
    if (!raw.trim()) return [];
    try {
      return [parseActorLine(actor, raw)];
    } catch {
      return [{ text: raw }];
    }
  });
}
function extractActorOutput(actor, rawEvents) {
  if (actor === "claude") return extractClaudeOutput(rawEvents);
  if (actor === "opencode") return extractOpenCodeOutput(rawEvents);
  if (actor === "kimi") return extractKimiOutput(rawEvents);
  return extractGenericJsonOutput(rawEvents);
}
function parseBuddyMessage(text) {
  const trimmed = text.trim();
  const jsonMessage = parseBuddyJsonMessage(trimmed);
  if (jsonMessage) return jsonMessage;
  const fields = /* @__PURE__ */ new Map();
  for (const line of trimmed.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index !== -1) fields.set(line.slice(0, index), line.slice(index + 1));
  }
  if (fields.get("type") === "break") {
    const reason = fields.get("reason");
    return { kind: "break", reason, content: reason ?? text };
  }
  return { kind: "message", text };
}
function parseBuddyJsonMessage(text) {
  const fenced = text.match(/```json\s*(\{[\s\S]*\})\s*```/i);
  if (fenced) {
    const parsed2 = parseBuddyJsonCandidate(fenced[1]);
    if (parsed2) return parsed2;
    const loose = looseExtractBuddyMessage(fenced[1]);
    if (loose) return loose;
  }
  const parsed = parseBuddyJsonCandidate(text);
  if (parsed) return parsed;
  if (text.startsWith("{")) {
    const loose = looseExtractBuddyMessage(text);
    if (loose) return loose;
  }
  const embedded = text.match(/\{[^{}]*"type"\s*:\s*"(?:chat|break)"[^{}]*\}/s);
  if (embedded) {
    return parseBuddyJsonCandidate(embedded[0]);
  }
  return null;
}
function parseBuddyJsonCandidate(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const type = parsed.type;
    const content = parsed.content;
    if ((type === "chat" || type === "break") && typeof content === "string") {
      return type === "break" ? { kind: "break", content } : { kind: "message", text: content };
    }
  } catch {
  }
  return null;
}
function looseExtractBuddyMessage(text) {
  const typeMatch = text.match(/"type"\s*:\s*"(chat|break)"/);
  if (!typeMatch) return null;
  const contentMatch = text.match(/"content"\s*:\s*"([\s\S]+)/);
  if (!contentMatch) return null;
  let content = contentMatch[1];
  const trimmedContent = content.trimEnd();
  const structuralEnd = /"\s*\}\s*$/.exec(trimmedContent);
  if (structuralEnd) {
    content = trimmedContent.slice(0, structuralEnd.index);
  }
  return typeMatch[1] === "break" ? { kind: "break", content } : { kind: "message", text: content };
}
function extractClaudeOutput(rawEvents) {
  let result = "";
  const chunks = [];
  for (const event of parseJsonEvents(rawEvents)) {
    const eventResult = textValue$1(event.result);
    if (event.type === "result" && eventResult) result = eventResult;
    const text = textValue$1(event.text);
    if (text) chunks.push(text);
    const message = objectValue$1(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      chunks.push(...content.map(textFromContentPart).filter(Boolean));
    }
  }
  return (result || chunks.join("\n")).trim();
}
function extractOpenCodeOutput(rawEvents) {
  const chunks = [];
  for (const event of parseJsonEvents(rawEvents)) {
    if (event.type === "text") {
      const part = objectValue$1(event.part);
      const text = textValue$1(part?.text);
      if (text) chunks.push(text);
    } else if (event.type === "error") {
      const error = stringifyValue(event.error);
      if (error) chunks.push(error);
    }
  }
  return chunks.join("").trim();
}
function extractKimiOutput(rawEvents) {
  let lastContent = "";
  for (const event of parseJsonEvents(rawEvents)) {
    if (event.role === "assistant") {
      const content = textValue$1(event.content);
      if (content) lastContent = content;
    }
  }
  return lastContent.trim();
}
function extractGenericJsonOutput(rawEvents) {
  const chunks = [];
  for (const event of parseJsonEvents(rawEvents)) {
    const item = objectValue$1(event.item);
    const itemText = textValue$1(item?.text);
    const message = textValue$1(event.message);
    const content = event.content;
    if (Array.isArray(content)) {
      chunks.push(...content.map(textFromContentPart).filter(Boolean));
    } else if (itemText) {
      chunks.push(itemText);
    } else if (message) {
      chunks.push(message);
    }
  }
  return chunks.join("\n").trim();
}
function parseJsonEvents(rawEvents) {
  const events = [];
  for (const raw of rawEvents.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const event = JSON.parse(raw);
      if (event && typeof event === "object" && !Array.isArray(event)) events.push(event);
    } catch {
    }
  }
  return events;
}
function claudeSessionIdFromEvent(event) {
  const sessionId = textValue$1(event.session_id);
  if (!sessionId) return void 0;
  const eventType = textValue$1(event.type);
  const subtype = textValue$1(event.subtype) ?? "";
  if (eventType === "system") {
    if (subtype === "init") return sessionId;
    if (subtype.startsWith("hook_") || event.hook_event) return void 0;
  }
  if (eventType === "result" || eventType === "assistant" || eventType === "user") return sessionId;
  if (eventType !== "system") return sessionId;
  return void 0;
}
function stableSessionIdFromEvent(actor, event) {
  if (event.type !== "buddy.session" || event.actor !== actor) return void 0;
  if (actor === "codex") return void 0;
  return textValue$1(event.session_id);
}
function stableThreadIdFromEvent(actor, event) {
  if (event.type === "buddy.session" && event.actor === "codex") {
    return textValue$1(event.thread_id) ?? textValue$1(event.session_id);
  }
  if (event.type === "thread.started") return textValue$1(event.thread_id);
  return void 0;
}
function textFromContentPart(part) {
  const candidate = objectValue$1(part);
  if (!candidate) return "";
  const type = candidate.type;
  return type === "text" || type === "output_text" ? textValue$1(candidate.text) ?? "" : "";
}
function objectValue$1(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function textValue$1(value) {
  return typeof value === "string" ? value : void 0;
}
function stringifyValue(value) {
  if (typeof value === "string") return value;
  if (value === void 0 || value === null) return void 0;
  return JSON.stringify(value);
}
const ACTOR_CLAUDE = "claude";
const ACTOR_CODEX = "codex";
const ACTOR_OPENCODE = "opencode";
const ACTOR_KIMI = "kimi";
const ROLE_MODE_CODEX_IMPL = "codex_implements";
const BUDDY_MESSAGE_PROTOCOL = `## Buddy Message Protocol

Your output is parsed by the buddy orchestrator. Wrap your response in the following JSON structure:

\`\`\`json
{
  "type": "chat",
  "content": "your response text here"
}
\`\`\`

- **type=chat**: Normal continuation. The loop proceeds to the next actor.
- **type=break**: Request to end the task. The other actor must also confirm with \`type=break\` before the task transitions to DONE.

Rules:
- Always output valid JSON matching this structure.
- Output raw JSON only - do NOT wrap it in a Markdown code block, and do NOT add any text before or after the JSON.
- Avoid unescaped double quotes inside \`content\`; use single quotes or escape them.
- Use \`type=break\` when: the task is fully completed, you are blocked and need human input, or continuing would be counterproductive.
- Use \`type=chat\` for all normal responses.
- The \`content\` field contains your actual response (markdown is fine).

## Dual confirmation

When one actor signals \`type=break\`, the task does NOT end immediately. The other actor must also confirm with \`type=break\` before the task transitions to DONE. If the other actor responds with \`type=chat\` instead, the break request is withdrawn and work continues.`;
function buildActorPrompt(input) {
  const taskText = input.taskText.trim();
  const contextText = input.contextText.trim();
  const state = input.state ?? {};
  const settings = input.settings ?? {};
  const contextHash = hashText(input.contextText);
  const contextSent = state.context_sent ?? {};
  const pendingBreak = state.pending_break;
  const parts = [
    "# buddy actor turn",
    "",
    "## Actor",
    input.actor,
    "",
    BUDDY_MESSAGE_PROTOCOL,
    "",
    "## Task",
    taskText
  ];
  if (contextText && (state.context_hash !== contextHash || !contextSent[input.actor])) {
    parts.push("", "## Background context", contextText);
  }
  if (pendingBreak) {
    const requesterLabel = actorDisplayName$1(pendingBreak.actor);
    parts.push(
      "",
      "## Break confirmation required",
      `${requesterLabel} has signaled \`type=break\` and believes the task is complete.`,
      "You must decide:",
      "- If you also agree the task is complete, respond with `type=break` to confirm. The task will then end.",
      "- If you think work should continue, respond with `type=chat` and describe what still needs to be done. The break request will be withdrawn."
    );
  }
  if (input.userMessage) {
    parts.push("", "## Human message", input.userMessage);
  }
  parts.push("", "## Runtime settings");
  parts.push(...runtimeSettingsLines(settings, state, input.actor, input.repoRoot));
  const recent = selectRecentTranscript(input.transcript);
  if (recent.length > 0) {
    parts.push("", "## Recent transcript");
    for (const item of recent) {
      parts.push(`### ${item.role}`, item.content);
    }
  }
  parts.push("", "## Instruction");
  const humanLang = detectHumanLanguage(input.transcript, input.userMessage ?? "", taskText, contextText);
  if (pendingBreak) {
    const requesterName = actorDisplayName$1(pendingBreak.actor);
    parts.push(`${requesterName} has requested to end the task. Confirm with \`type=break\` or continue with \`type=chat\`.`);
  } else {
    const implementer = implementerActor(settings);
    if (input.actor === implementer) {
      parts.push("Continue the implementation work. Report changed files, what you did, and blockers.");
    } else {
      parts.push("Review the current task state. Report blocking findings first, then concise next action.");
    }
  }
  if (humanLang) {
    parts.push(`默认使用最近 human message 的语言输出；当前任务使用${humanLang}。除 JSON 等编程语言外，所有自然语言内容都用${humanLang}输出。`);
  }
  return `${parts.join("\n").trimEnd()}
`;
}
function runtimeSettingsLines(settings, state, actor, repoRoot = "") {
  const maxRounds = numberValue$1(settings.max_rounds, 10);
  const roundsInWindow = numberValue$1(state.rounds_in_window, 0);
  const remaining = maxRounds > 0 ? Math.max(0, maxRounds - roundsInWindow) : "unlimited";
  const lines = [
    `- Current total round: ${numberValue$1(state.round, 0)}`,
    `- Automatic rounds used in this window: ${roundsInWindow}/${maxRounds || "unlimited"}`,
    `- Automatic rounds remaining in this window: ${remaining}`,
    `- Next actor after this turn: ${nextActor(actor, settings)}`
  ];
  if (repoRoot) lines.push(`- Repository: ${repoRoot}`);
  if (state.countdown?.deadline) lines.push(`- Active countdown deadline: ${state.countdown.deadline}`);
  return lines;
}
function selectRecentTranscript(transcript, window = 6) {
  const recent = transcript.slice(-window);
  const recentKeys = new Set(recent.map(rowKey));
  const earlier = transcript.slice(0, -window);
  for (const role of ["human", ACTOR_CLAUDE, ACTOR_CODEX, ACTOR_OPENCODE, ACTOR_KIMI]) {
    if (recent.some((item) => item.role === role)) continue;
    const last = [...earlier].reverse().find((item) => item.role === role);
    if (last && !recentKeys.has(rowKey(last))) {
      recent.unshift(last);
      recentKeys.add(rowKey(last));
    }
  }
  return recent.sort((a, b) => seqValue(a) - seqValue(b));
}
function detectHumanLanguage(transcript, userMessage = "", taskText = "", contextText = "") {
  let text = userMessage.trim();
  if (!text) {
    const latestHuman = [...transcript].reverse().find((item) => item.role === "human");
    text = latestHuman?.content.trim() ?? "";
  }
  if (!text) text = taskText.trim();
  if (!text) text = contextText.trim();
  if (!text) return "";
  let cjkCount = 0;
  for (const ch of text) {
    if ("一" <= ch && ch <= "鿿" || "㐀" <= ch && ch <= "䶿") cjkCount += 1;
  }
  const nonSpace = text.replace(/\s/g, "").length;
  return nonSpace > 0 && cjkCount / nonSpace > 0.1 ? "中文" : "English";
}
function nextActor(actor, settings) {
  const implementer = settings.implementer_actor ?? ACTOR_CLAUDE;
  const reviewer = settings.reviewer_actor ?? ACTOR_CODEX;
  return actor === implementer ? reviewer : implementer;
}
function implementerActor(settings) {
  return settings.implementer_actor ?? (settings.role_mode === ROLE_MODE_CODEX_IMPL ? ACTOR_CODEX : ACTOR_CLAUDE);
}
function actorDisplayName$1(actor) {
  if (actor === ACTOR_CLAUDE) return "Claude Code";
  if (actor === ACTOR_OPENCODE) return "OpenCode";
  if (actor === ACTOR_KIMI) return "Kimi";
  if (actor === ACTOR_CODEX) return "Codex";
  return typeof actor === "string" && actor ? actor : "Codex";
}
function hashText(text) {
  return node_crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
function rowKey(item) {
  const seq = seqValue(item);
  return seq || `${item.role}:${item.ts}:${item.content}`;
}
function seqValue(item) {
  const seq = item.seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : 0;
}
function numberValue$1(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
const ACTOR_STATUS = {
  claude: "RUNNING_CLAUDE",
  codex: "RUNNING_CODEX",
  opencode: "RUNNING_OPENCODE",
  kimi: "RUNNING_KIMI"
};
class BuddyRunner {
  constructor(store, options = {}) {
    this.store = store;
    this.executeLaunchers = options.executeLaunchers ?? true;
  }
  async startTask(taskId, input) {
    if (!input.workspace_key) throw new Error("workspace_key is required");
    const workspaceKey = input.workspace_key;
    const detail = await this.store.getTaskDetail(taskId, workspaceKey);
    const actor = input.actor ?? (detail.state.status === "FAILED" ? detail.state.latest_failure?.actor ?? detail.state.last_error?.actor : void 0) ?? detail.state.next_actor ?? "claude";
    const status = ACTOR_STATUS[actor];
    if (!status) throw new Error(`Unsupported actor: ${actor}`);
    if (!canStartFrom(detail.state.status)) {
      throw new Error(`Cannot start task from ${detail.state.status}`);
    }
    const maxRounds = detail.settings.max_rounds ?? 10;
    const roundsInWindow = detail.state.rounds_in_window ?? 0;
    if (maxRounds > 0 && roundsInWindow >= maxRounds) {
      await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
        ...state,
        status: "PAUSED",
        active_run: null,
        countdown: null,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      }));
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: "round_window.paused",
        payload: { max_rounds: maxRounds, rounds_in_window: roundsInWindow }
      });
      throw new Error(`本次自动推进已达到自动轮次上限。点击“继续”可以再推进 ${maxRounds} 轮。`);
    }
    const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const sessionIdBefore = sessionIdForActor(actor, detail.state, detail.settings);
    await this.store.updateTaskState(taskId, workspaceKey, (state) => {
      if (!canStartFrom(state.status)) {
        throw new Error(`Cannot start task from ${state.status}`);
      }
      return {
        ...state,
        status,
        active_run: {
          run_id: runId,
          actor,
          started_at: startedAt,
          status: "running",
          session_id_before: sessionIdBefore ?? null,
          session_id_after: null
        },
        countdown: null,
        latest_failure: null,
        last_error: null,
        updated_at: startedAt
      };
    });
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: "actor.started",
      actor,
      run_id: runId,
      payload: { run_id: runId, mode: sessionIdBefore ? "resume" : "start" }
    });
    if (!this.executeLaunchers) {
      return { run_id: runId };
    }
    await this.executeActor(taskId, workspaceKey, actor, runId, input.message ?? "");
    return { run_id: runId };
  }
  async sendMessage(taskId, input) {
    if (!input.workspace_key) throw new Error("workspace_key is required");
    const message = input.message ?? "";
    if (!message.trim()) throw new Error("message is required");
    await this.store.appendTranscript(
      taskId,
      input.workspace_key,
      "human",
      message,
      { source: "run_once" }
    );
    await this.store.appendTaskEvent(taskId, input.workspace_key, {
      type: "human.message",
      actor: input.actor,
      payload: { content: message }
    });
    await this.startTask(taskId, {
      workspace_key: input.workspace_key,
      actor: input.actor,
      message
    });
  }
  async pauseCountdown(taskId, input) {
    if (!input.workspace_key) throw new Error("workspace_key is required");
    const detail = await this.store.getTaskDetail(taskId, input.workspace_key);
    if (detail.state.status !== "COUNTDOWN") return;
    const actor = input.next_actor ?? detail.state.next_actor ?? detail.state.countdown?.default_next_actor ?? "claude";
    await this.store.updateTaskState(taskId, input.workspace_key, (state) => {
      const countdown = state.countdown ?? { status: "running", remaining: 0, default_next_actor: actor };
      return {
        ...state,
        status: "READY",
        next_actor: actor,
        countdown: { ...countdown, status: "paused" },
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      };
    });
    await this.store.appendTaskEvent(taskId, input.workspace_key, {
      type: "countdown.paused",
      payload: { next_actor: actor }
    });
  }
  async skipCountdown(taskId, input) {
    if (!input.workspace_key) throw new Error("workspace_key is required");
    const detail = await this.store.getTaskDetail(taskId, input.workspace_key);
    if (detail.state.status !== "COUNTDOWN") throw new Error(`当前任务不在倒计时中：${taskId}`);
    const actor = input.next_actor ?? detail.state.next_actor ?? detail.state.countdown?.default_next_actor;
    if (!actor) throw new Error("next actor is required");
    await this.store.updateTaskState(taskId, input.workspace_key, (state) => ({
      ...state,
      status: "READY",
      next_actor: actor,
      countdown: state.countdown ? { ...state.countdown, status: "skipped" } : void 0,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }));
    await this.store.appendTaskEvent(taskId, input.workspace_key, {
      type: "countdown.skipped",
      payload: { next_actor: actor }
    });
    return this.startTask(taskId, { workspace_key: input.workspace_key, actor });
  }
  async interrupt(taskId, workspaceKey) {
    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: "PAUSED",
      active_run: null,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }));
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: "actor.interrupted",
      payload: {}
    });
  }
  async executeActor(taskId, workspaceKey, actor, runId, userMessage = "") {
    const detail = await this.store.getTaskDetail(taskId, workspaceKey);
    const launcher = detail.settings.launchers[actor] ?? {
      command: actor,
      env: {},
      timeout_seconds: 600
    };
    const taskDirectory = this.store.taskDirectory(taskId, workspaceKey);
    const artifactsDir = node_path.join(taskDirectory, "artifacts");
    await promises.mkdir(artifactsDir, { recursive: true });
    const prompt = buildActorPrompt({
      actor,
      round: detail.state.round,
      repoRoot: detail.state.repo_root ?? "",
      taskText: detail.task_text,
      contextText: detail.context_text,
      transcript: detail.transcript,
      settings: detail.settings,
      state: detail.state,
      userMessage
    });
    const promptFile = node_path.join(artifactsDir, `${runId}-prompt.md`);
    const outputFile = node_path.join(artifactsDir, `${runId}-output.md`);
    const eventFile = node_path.join(artifactsDir, `${runId}-events.jsonl`);
    await promises.writeFile(promptFile, prompt);
    const cwd = await existingCwd(detail.state.repo_root);
    const existingSessionId = sessionIdForActor(actor, detail.state, detail.settings);
    const commandKind = commandKindFor(actor, launcher.command);
    const sessionId = actor === "kimi" && commandKind === "native_kimi" && !existingSessionId ? node_crypto.randomBytes(8).toString("hex") : existingSessionId;
    const command = buildLauncherCommand({
      actor,
      command: launcher.command,
      mode: existingSessionId ? "resume" : "start",
      promptFile,
      promptText: prompt,
      eventFile,
      outputFile,
      repoRoot: cwd,
      taskDir: taskDirectory,
      runId,
      sessionId
    });
    const outputLines = [];
    const stderrLines = [];
    const lockPath = await createRunLock(this.store.dataRoot, {
      workspace_key: workspaceKey,
      task_id: taskId,
      run_id: runId,
      pid: process.pid
    });
    try {
      const startedAtMs = Date.now();
      const result = await runLauncher({
        command: command.command,
        args: command.args,
        cwd,
        env: { ...launcher.env, ...command.env ?? {} },
        stdinText: command.stdinText,
        timeoutMs: launcher.timeout_seconds * 1e3,
        onStdout: (line) => {
          outputLines.push(line);
        },
        onStderr: (line) => stderrLines.push(line)
      });
      const elapsedMs = Date.now() - startedAtMs;
      const stdoutText = outputLines.join("\n");
      const rawEvents = await collectRawEvents(eventFile, stdoutText, command.kind);
      const outputText = await collectOutputText(actor, command.kind, outputFile, stdoutText);
      const parsedLines = parseActorEvents(actor, rawEvents);
      if (actor === "kimi" && sessionId && !parsedLines.some((line) => line.sessionId)) {
        parsedLines.push({ sessionId });
      }
      if (result.exitCode !== 0) {
        throw new Error(stderrLines.join("\n") || `Actor exited with ${result.exitCode}`);
      }
      await this.completeActor(taskId, workspaceKey, actor, runId, outputText, parsedLines, elapsedMs, result.exitCode ?? 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureMessage = stderrLines.join("\n") || message;
      await this.markFailed(taskId, workspaceKey, actor, failureMessage, runId);
      throw error;
    } finally {
      await removeRunLock(lockPath);
    }
  }
  async completeActor(taskId, workspaceKey, actor, runId, outputText, parsedLines, elapsedMs, exitCode) {
    const text = outputText;
    const sessionId = lastValue(parsedLines.map((line) => line.sessionId));
    const threadId = lastValue(parsedLines.map((line) => line.threadId));
    const message = parseBuddyMessage(text);
    const detail = await this.store.getTaskDetail(taskId, workspaceKey);
    const nextActor$1 = nextActor(actor, detail.settings);
    const round = (detail.state.round ?? 0) + 1;
    const roundsInWindow = (detail.state.rounds_in_window ?? 0) + 1;
    const maxRounds = detail.settings.max_rounds ?? 10;
    const roundWindowReached = maxRounds > 0 && roundsInWindow >= maxRounds;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const buddyType = message.kind === "break" ? "break" : "chat";
    const transcriptContent = message.kind === "break" ? message.content : message.text;
    const pendingBreak = detail.state.pending_break;
    const breakConfirmed = message.kind === "break" && Boolean(pendingBreak?.actor && pendingBreak.actor !== actor);
    const breakPending = message.kind === "break" && !breakConfirmed;
    const breakRejected = message.kind !== "break" && Boolean(pendingBreak?.actor);
    await this.store.appendTranscript(taskId, workspaceKey, normalizeActorRole(actor), transcriptContent, {
      round,
      run_id: runId,
      elapsed_ms: elapsedMs,
      buddy_type: buddyType
    });
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: "actor.completed",
      actor,
      run_id: runId,
      payload: { run_id: runId, text: transcriptContent, raw_text: text, buddy_type: buddyType }
    });
    await this.store.updateTaskState(taskId, workspaceKey, (state) => {
      const contextSent = { ...state.context_sent ?? {} };
      contextSent[actor] = true;
      const next = {
        ...state,
        active_run: null,
        round,
        rounds_in_window: roundsInWindow,
        next_actor: nextActor$1,
        context_hash: hashText(detail.context_text),
        context_sent: contextSent,
        latest_failure: null,
        last_error: null,
        consecutive_failures: 0,
        updated_at: now
      };
      if (actor === "claude" && sessionId) next.claude_session_id = sessionId;
      if (actor === "codex" && threadId) next.codex_thread_id = threadId;
      if (actor === "opencode" && sessionId) next.opencode_session_id = sessionId;
      if (actor === "kimi" && sessionId) next.kimi_session_id = sessionId;
      if (breakConfirmed) {
        return {
          ...next,
          status: "DONE",
          countdown: null,
          pending_break: null
        };
      }
      if (breakPending) {
        return {
          ...next,
          status: roundWindowReached ? "PAUSED" : "COUNTDOWN",
          pending_break: { actor, round },
          countdown: roundWindowReached ? null : {
            status: "running",
            started_at: now,
            after_actor: actor,
            remaining: detail.settings.countdown_seconds,
            default_next_actor: nextActor$1,
            deadline: new Date(Date.now() + detail.settings.countdown_seconds * 1e3).toISOString()
          }
        };
      }
      return {
        ...next,
        status: roundWindowReached ? "PAUSED" : "COUNTDOWN",
        pending_break: breakRejected ? null : next.pending_break,
        countdown: roundWindowReached ? null : {
          status: "running",
          started_at: now,
          after_actor: actor,
          remaining: detail.settings.countdown_seconds,
          default_next_actor: nextActor$1,
          deadline: new Date(Date.now() + detail.settings.countdown_seconds * 1e3).toISOString()
        }
      };
    });
    if (breakConfirmed) {
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: "actor.finished",
        actor,
        run_id: runId,
        payload: { elapsed_ms: elapsedMs, exit_code: exitCode, buddy_type: "break_confirmed" }
      });
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        "system",
        `${actorDisplayName(pendingBreak?.actor)} 和 ${actorDisplayName(actor)} 均确认任务完成，任务结束。`,
        { kind: "round_notice", round }
      );
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: "task.done",
        payload: {
          reason: "dual_break_confirmed",
          first_actor: pendingBreak?.actor,
          second_actor: actor,
          round
        }
      });
      return;
    }
    if (breakPending) {
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        "system",
        `${actorDisplayName(actor)} 请求结束任务，等待 ${actorDisplayName(nextActor$1)} 确认。`,
        { kind: "round_notice", round }
      );
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: "break.pending",
        actor,
        run_id: runId,
        payload: {
          elapsed_ms: elapsedMs,
          exit_code: exitCode,
          buddy_type: "break",
          pending_confirmation_from: nextActor$1
        }
      });
    } else if (breakRejected) {
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: "break.rejected",
        actor,
        run_id: runId,
        payload: { rejected_break_from: pendingBreak?.actor }
      });
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        "system",
        `${actorDisplayName(actor)} 认为任务尚未完成，${actorDisplayName(pendingBreak?.actor)} 的结束请求已撤回。`,
        { kind: "round_notice", round }
      );
    }
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: "actor.finished",
      actor,
      run_id: runId,
      payload: { elapsed_ms: elapsedMs, exit_code: exitCode, buddy_type: buddyType }
    });
    if (roundWindowReached) {
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        "system",
        `${actorDisplayName(actor)} 已达到轮次上限，暂停等待确认。`,
        { kind: "round_notice", round }
      );
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: "round_window.paused",
        payload: {
          max_rounds: maxRounds,
          rounds_in_window: roundsInWindow,
          next_actor: nextActor$1
        }
      });
      return;
    }
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: "countdown.started",
      payload: {
        seconds: detail.settings.countdown_seconds,
        after_actor: actor,
        default_next_actor: nextActor$1
      }
    });
  }
  async markFailed(taskId, workspaceKey, actor, message, runId) {
    const failure = {
      message,
      actor,
      ts: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: "FAILED",
      active_run: null,
      consecutive_failures: (state.consecutive_failures ?? 0) + 1,
      last_error: failure,
      latest_failure: failure,
      updated_at: failure.ts
    }));
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: "actor.failed",
      actor,
      run_id: runId,
      payload: { error: message, run_id: runId }
    });
  }
}
function canStartFrom(status) {
  return status === "READY" || status === "PAUSED" || status === "FAILED" || status === "COUNTDOWN" || status === "DONE";
}
function sessionIdForActor(actor, state, settings) {
  if (actor === "claude") return state.claude_session_id ?? stringSetting(settings, "seed_claude_session_id");
  if (actor === "codex") return state.codex_thread_id ?? stringSetting(settings, "seed_codex_thread_id");
  if (actor === "opencode") return state.opencode_session_id ?? stringSetting(settings, "seed_opencode_session_id");
  if (actor === "kimi") return state.kimi_session_id ?? stringSetting(settings, "seed_kimi_session_id");
  return void 0;
}
function stringSetting(settings, key) {
  const value = settings?.[key];
  return typeof value === "string" && value ? value : void 0;
}
function normalizeActorRole(actor) {
  if (actor === "claude" || actor === "codex" || actor === "opencode" || actor === "kimi") return actor;
  return "system";
}
function actorDisplayName(actor) {
  if (actor === "claude") return "Claude Code";
  if (actor === "codex") return "Codex";
  if (actor === "opencode") return "OpenCode";
  if (actor === "kimi") return "Kimi";
  return typeof actor === "string" && actor ? actor : "Unknown";
}
function lastValue(values) {
  const filtered = values.filter(Boolean);
  return filtered[filtered.length - 1];
}
async function existingCwd(path2) {
  if (!path2) return process.cwd();
  try {
    await promises.access(path2);
    return path2;
  } catch {
    return process.cwd();
  }
}
async function fileExists(path2) {
  try {
    await promises.access(path2);
    return true;
  } catch {
    return false;
  }
}
async function collectRawEvents(eventFile, stdoutText, kind) {
  if (kind !== "contract") {
    if (stdoutText) await promises.writeFile(eventFile, stdoutText);
    return stdoutText;
  }
  const fileText = await readOptionalText$1(eventFile);
  if (fileText && stdoutText) return `${fileText.trimEnd()}
${stdoutText}`;
  if (fileText) return fileText;
  if (stdoutText) {
    await promises.writeFile(eventFile, stdoutText);
    return stdoutText;
  }
  return "";
}
async function collectOutputText(actor, kind, outputFile, stdoutText) {
  if (kind === "native_claude" || kind === "native_opencode" || kind === "native_kimi") {
    const output = extractActorOutput(actor, stdoutText);
    await promises.writeFile(outputFile, output);
    return output;
  }
  if (await fileExists(outputFile)) return promises.readFile(outputFile, "utf8");
  const extracted = extractActorOutput(actor, stdoutText);
  return extracted || stdoutText;
}
async function readOptionalText$1(path2) {
  try {
    return await promises.readFile(path2, "utf8");
  } catch {
    return "";
  }
}
const DEFAULT_LAUNCHER_ORDER = ["claude", "codex"];
const DEFAULT_LAUNCHER_TIMEOUT_SECONDS = 7200;
const DEFAULT_LAUNCHER_COMMANDS = {
  claude: "claude",
  codex: "codex"
};
function defaultLauncherFor(actor) {
  return {
    command: DEFAULT_LAUNCHER_COMMANDS[actor] ?? actor,
    env: {},
    timeout_seconds: DEFAULT_LAUNCHER_TIMEOUT_SECONDS
  };
}
function normalizeLauncher(actor, launcher) {
  const fallback = defaultLauncherFor(actor);
  return {
    command: typeof launcher?.command === "string" ? launcher.command : fallback.command,
    env: launcher?.env ? { ...launcher.env } : { ...fallback.env },
    timeout_seconds: typeof launcher?.timeout_seconds === "number" ? launcher.timeout_seconds : fallback.timeout_seconds
  };
}
function normalizeLaunchers(launchers) {
  const normalized = {};
  for (const actor of DEFAULT_LAUNCHER_ORDER) {
    normalized[actor] = normalizeLauncher(actor, launchers?.[actor]);
  }
  for (const [actor, launcher] of Object.entries(launchers ?? {})) {
    if (!normalized[actor]) {
      normalized[actor] = normalizeLauncher(actor, launcher);
    }
  }
  return normalized;
}
function normalizeGlobalSettings(settings) {
  return {
    protocol_version: settings?.protocol_version ?? "1",
    countdown_seconds: settings?.countdown_seconds ?? 30,
    max_rounds: settings?.max_rounds ?? 10,
    max_consecutive_failures: settings?.max_consecutive_failures ?? 3,
    launchers: normalizeLaunchers(settings?.launchers),
    seed_claude_session_id: settings?.seed_claude_session_id ?? "",
    seed_codex_thread_id: settings?.seed_codex_thread_id ?? ""
  };
}
function createBuddyPaths(dataRoot) {
  return {
    dataRoot,
    globalSettings: node_path.join(dataRoot, "global", "settings.json"),
    workspacesDir: node_path.join(dataRoot, "workspaces"),
    runtimeTasksDir: node_path.join(dataRoot, "runtime", "tasks")
  };
}
function workspaceKeyForRepo(repoRoot) {
  const root = node_path.resolve(repoRoot);
  const slug = (node_path.basename(root) || "root").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 40) || "workspace";
  const digest = node_crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}
function workspaceDir(paths, workspaceKey) {
  return node_path.join(paths.workspacesDir, workspaceKey);
}
function taskDir(paths, workspaceKey, taskId) {
  return node_path.join(workspaceDir(paths, workspaceKey), "tasks", taskId);
}
function canonicalRepoRoot(repoRoot) {
  const root = node_path.resolve(repoRoot);
  try {
    return node_fs.realpathSync.native(root);
  } catch {
    return root;
  }
}
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g
];
function redactSensitiveText(input) {
  return PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), input);
}
function redactJsonValue(value) {
  return JSON.parse(redactSensitiveText(JSON.stringify(value)));
}
const taskStatusSchema = zod.z.enum([
  "READY",
  "RUNNING_CLAUDE",
  "RUNNING_CODEX",
  "RUNNING_OPENCODE",
  "RUNNING_KIMI",
  "COUNTDOWN",
  "PAUSED",
  "FAILED",
  "DONE"
]);
const activeRunSchema = zod.z.object({
  run_id: zod.z.string().optional(),
  actor: zod.z.string(),
  started_at: zod.z.string(),
  status: zod.z.literal("running").optional(),
  session_id_before: zod.z.string().nullable().optional(),
  session_id_after: zod.z.string().nullable().optional()
});
const countdownSchema = zod.z.object({
  status: zod.z.enum(["running", "paused", "elapsed", "skipped", "expired"]),
  remaining: zod.z.number().optional().default(0),
  started_at: zod.z.string().optional(),
  after_actor: zod.z.string().optional(),
  default_next_actor: zod.z.string(),
  deadline: zod.z.string().optional()
});
const failureSchema = zod.z.object({
  message: zod.z.string(),
  actor: zod.z.string().optional(),
  run_id: zod.z.string().optional(),
  ts: zod.z.string().optional(),
  output_file: zod.z.string().optional(),
  event_file: zod.z.string().optional()
});
const taskStateSchema = zod.z.object({
  protocol_version: zod.z.string().optional(),
  task_id: zod.z.string().optional(),
  repo_root: zod.z.string().optional(),
  status: taskStatusSchema,
  round: zod.z.number(),
  rounds_in_window: zod.z.number().default(0),
  next_actor: zod.z.string(),
  countdown: countdownSchema.nullable().optional(),
  active_run: activeRunSchema.nullable().optional(),
  claude_session_id: zod.z.string().nullable().optional(),
  codex_thread_id: zod.z.string().nullable().optional(),
  opencode_session_id: zod.z.string().nullable().optional(),
  kimi_session_id: zod.z.string().nullable().optional(),
  context_hash: zod.z.string().optional(),
  context_sent: zod.z.record(zod.z.string(), zod.z.boolean()).default({}),
  event_seq: zod.z.number().optional(),
  transcript_seq: zod.z.number().optional(),
  consecutive_failures: zod.z.number().optional(),
  last_error: failureSchema.nullable().optional(),
  created_at: zod.z.string().optional(),
  updated_at: zod.z.string().optional(),
  pending_break: zod.z.object({ actor: zod.z.string().optional(), round: zod.z.number().optional() }).nullable().optional(),
  latest_failure: failureSchema.nullable().optional()
});
const launcherSchema = zod.z.object({
  command: zod.z.string(),
  env: zod.z.record(zod.z.string(), zod.z.string()).default({}),
  timeout_seconds: zod.z.number().default(600)
});
const taskSettingsSchema = zod.z.object({
  protocol_version: zod.z.string().default("1"),
  countdown_seconds: zod.z.number().default(30),
  flow_policy: zod.z.string().default("claude_then_codex"),
  role_mode: zod.z.string().default("claude_implements"),
  launchers: zod.z.record(zod.z.string(), launcherSchema).default({}),
  implementer_actor: zod.z.string().optional(),
  reviewer_actor: zod.z.string().optional(),
  max_rounds: zod.z.number().optional(),
  max_consecutive_failures: zod.z.number().optional(),
  seed_claude_session_id: zod.z.string().optional(),
  seed_codex_thread_id: zod.z.string().optional(),
  seed_opencode_session_id: zod.z.string().optional(),
  seed_kimi_session_id: zod.z.string().optional()
});
const globalSettingsSchema = zod.z.object({
  protocol_version: zod.z.string().default("1"),
  countdown_seconds: zod.z.number().default(30),
  max_rounds: zod.z.number().default(10),
  max_consecutive_failures: zod.z.number().default(3),
  launchers: zod.z.record(zod.z.string(), launcherSchema).default({}),
  seed_claude_session_id: zod.z.string().optional(),
  seed_codex_thread_id: zod.z.string().optional()
});
const eventSchema = zod.z.object({
  seq: zod.z.number(),
  task_id: zod.z.string().optional(),
  type: zod.z.string(),
  actor: zod.z.string().optional(),
  ts: zod.z.string(),
  run_id: zod.z.string().optional(),
  payload: zod.z.record(zod.z.string(), zod.z.unknown())
});
function parseTaskState(input) {
  return taskStateSchema.parse(input);
}
function parseTaskSettings(input) {
  return taskSettingsSchema.parse(input);
}
function parseGlobalSettings(input) {
  return globalSettingsSchema.parse(input);
}
function parseEventLine(line) {
  return eventSchema.parse(JSON.parse(line));
}
const ACTORS = ["claude", "codex", "opencode", "kimi"];
class BuddyStore {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
  }
  async getTasks() {
    const paths = createBuddyPaths(this.dataRoot);
    const workspaceKeys = await listDirectoryNames(paths.workspacesDir);
    const tasks = [];
    for (const workspaceKey of workspaceKeys) {
      const tasksDir = node_path.join(paths.workspacesDir, workspaceKey, "tasks");
      const taskIds = await listDirectoryNames(tasksDir);
      for (const taskId of taskIds) {
        try {
          const state = await this.readTaskState(taskId, workspaceKey);
          tasks.push({
            task_id: taskId,
            workspace_key: workspaceKey,
            status: state.status,
            updated_at: state.updated_at ?? "",
            repo_root: state.repo_root ?? "",
            round: state.round,
            active_run: state.active_run ?? null
          });
        } catch {
        }
      }
    }
    return tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async getTaskDetail(taskId, workspaceKey) {
    const state = await this.readTaskState(taskId, workspaceKey);
    const settings = await this.readTaskSettings(taskId, workspaceKey);
    const meta = await this.readTaskMeta(taskId, workspaceKey);
    const events = await this.readEvents(taskId, workspaceKey);
    return {
      task_id: taskId,
      workspace_key: workspaceKey,
      state,
      settings,
      task_text: meta.task_text ?? "",
      context_text: meta.context_text ?? "",
      transcript: await this.readTranscript(taskId, workspaceKey),
      events,
      latest_failure: state.latest_failure ?? state.last_error ?? null
    };
  }
  async getEvents(taskId, since, workspaceKey) {
    const events = await this.readEvents(taskId, workspaceKey);
    return { events: events.filter((event) => event.seq > since) };
  }
  async createTask(input) {
    const repoRoot = canonicalRepoRoot(input.repo_root ?? "");
    const workspaceKey = workspaceKeyForRepo(repoRoot || input.task_id);
    const dir = this.taskDirectory(input.task_id, workspaceKey);
    const now = utcNow();
    const taskText = taskMarkdownContent(input.task_text ?? "");
    const contextText = contextMarkdownContent(input.context_text ?? "");
    const globalSettings = await this.readGlobalSettings();
    const settings = defaultTaskSettings(globalSettings, input.settings);
    const state = defaultTaskState(input.task_id, repoRoot, settings, contextText, now);
    state.event_seq = 1;
    await promises.mkdir(node_path.join(dir, "rounds"), { recursive: true });
    await promises.mkdir(node_path.join(dir, "artifacts"), { recursive: true });
    await this.writeWorkspaceMetadata(workspaceKey, repoRoot, now);
    await atomicWriteText(node_path.join(dir, "task.md"), taskText);
    await atomicWriteText(node_path.join(dir, "context.md"), contextText);
    await atomicWriteJson(node_path.join(dir, "settings.json"), settings);
    await atomicWriteJson(node_path.join(dir, "state.json"), state);
    await atomicWriteText(node_path.join(dir, "status"), `${state.status}
`);
    await atomicAppendText(node_path.join(dir, ".buddy.lock"), "");
    await appendEventLine(node_path.join(dir, "events.jsonl"), {
      seq: 1,
      task_id: input.task_id,
      type: "task.created",
      ts: now,
      payload: {
        task_id: input.task_id
      }
    });
    return { task: input.task_id, path: dir, workspace_key: workspaceKey };
  }
  async deleteTask(taskId, workspaceKey) {
    await promises.rm(this.taskDirectory(taskId, workspaceKey), { recursive: true, force: true });
  }
  async updateGlobalSettings(settings) {
    const path2 = createBuddyPaths(this.dataRoot).globalSettings;
    const normalized = normalizeGlobalSettings(settings);
    await atomicWriteJson(path2, normalized);
    return normalized;
  }
  async readGlobalSettings() {
    const path2 = createBuddyPaths(this.dataRoot).globalSettings;
    const legacyPath = node_path.join(this.dataRoot, "global_settings.json");
    try {
      const parsed = parseGlobalSettings(await readJson(path2));
      return normalizeGlobalSettings(parsed);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    try {
      const parsed = parseGlobalSettings(await readJson(legacyPath));
      return normalizeGlobalSettings(parsed);
    } catch (error) {
      if (isNotFoundError(error)) return normalizeGlobalSettings();
      throw error;
    }
  }
  async readTaskState(taskId, workspaceKey) {
    return parseTaskState(await readJson(this.statePath(taskId, workspaceKey)));
  }
  async readTaskSettings(taskId, workspaceKey) {
    return parseTaskSettings(await readJson(this.settingsPath(taskId, workspaceKey)));
  }
  async updateTaskState(taskId, workspaceKey, update) {
    const next = update(await this.readTaskState(taskId, workspaceKey));
    return this.writeTaskState(taskId, workspaceKey, next);
  }
  async appendTaskEvent(taskId, workspaceKey, event) {
    const events = await this.readEvents(taskId, workspaceKey);
    const state = await this.readTaskState(taskId, workspaceKey);
    const next = {
      seq: event.seq ?? Math.max(
        state.event_seq ?? 0,
        events.reduce((max, item) => Math.max(max, item.seq), 0)
      ) + 1,
      task_id: taskId,
      ts: event.ts ?? utcNow(),
      type: event.type,
      actor: event.actor,
      run_id: event.run_id,
      payload: event.payload
    };
    const redacted = redactJsonValue(next);
    await appendEventLine(this.eventsPath(taskId, workspaceKey), redacted);
    await this.writeTaskState(taskId, workspaceKey, {
      ...state,
      event_seq: next.seq
    });
    return redacted;
  }
  async appendTranscript(taskId, workspaceKey, role, content, meta = {}) {
    const state = await this.readTaskState(taskId, workspaceKey);
    const seq = (state.transcript_seq ?? 0) + 1;
    const row = {
      seq,
      ts: utcNow(),
      role,
      content,
      meta
    };
    await atomicAppendText(
      this.transcriptJsonlPath(taskId, workspaceKey),
      `${stringifyPythonJsonLine(row)}
`
    );
    await this.writeTaskState(taskId, workspaceKey, {
      ...state,
      transcript_seq: seq
    });
    return row;
  }
  taskDirectory(taskId, workspaceKey) {
    return taskDir(createBuddyPaths(this.dataRoot), workspaceKey, taskId);
  }
  statePath(taskId, workspaceKey) {
    return node_path.join(this.taskDirectory(taskId, workspaceKey), "state.json");
  }
  settingsPath(taskId, workspaceKey) {
    return node_path.join(this.taskDirectory(taskId, workspaceKey), "settings.json");
  }
  eventsPath(taskId, workspaceKey) {
    return node_path.join(this.taskDirectory(taskId, workspaceKey), "events.jsonl");
  }
  transcriptJsonlPath(taskId, workspaceKey) {
    return node_path.join(this.taskDirectory(taskId, workspaceKey), "transcript.jsonl");
  }
  async writeWorkspaceMetadata(workspaceKey, repoRoot, now) {
    await atomicWriteJson(node_path.join(createBuddyPaths(this.dataRoot).workspacesDir, workspaceKey, "workspace.json"), {
      protocol_version: "1",
      workspace_key: workspaceKey,
      default_repo_root: repoRoot,
      updated_at: now
    });
  }
  async readTaskMeta(taskId, workspaceKey) {
    const markdown = await this.readMarkdownTaskMeta(taskId, workspaceKey);
    if (markdown) return markdown;
    const path2 = node_path.join(this.taskDirectory(taskId, workspaceKey), "task.json");
    try {
      return await readJson(path2);
    } catch {
      return { task_text: "", context_text: "" };
    }
  }
  async readMarkdownTaskMeta(taskId, workspaceKey) {
    const dir = this.taskDirectory(taskId, workspaceKey);
    const [taskText, contextText] = await Promise.all([
      readOptionalText(node_path.join(dir, "task.md")),
      readOptionalText(node_path.join(dir, "context.md"))
    ]);
    if (!taskText && !contextText) return null;
    return {
      task_text: taskText,
      context_text: contextText
    };
  }
  async readEvents(taskId, workspaceKey) {
    const path2 = this.eventsPath(taskId, workspaceKey);
    try {
      const text = await promises.readFile(path2, "utf8");
      return text.split(/\r?\n/).filter(Boolean).map(parseEventLine);
    } catch {
      return [];
    }
  }
  async readTranscript(taskId, workspaceKey) {
    return this.readTranscriptJsonl(taskId, workspaceKey);
  }
  async readTranscriptJsonl(taskId, workspaceKey) {
    const text = await readOptionalText(this.transcriptJsonlPath(taskId, workspaceKey));
    if (!text.trim()) return [];
    return text.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return transcriptEntryFromJson(JSON.parse(line));
      } catch {
        return [];
      }
    });
  }
  async writeTaskState(taskId, workspaceKey, state) {
    const current = await readOptionalJson(this.statePath(taskId, workspaceKey));
    const next = {
      ...state,
      protocol_version: "1",
      event_seq: Math.max(numberValue(state.event_seq) ?? 0, numberValue(current?.event_seq) ?? 0),
      transcript_seq: Math.max(numberValue(state.transcript_seq) ?? 0, numberValue(current?.transcript_seq) ?? 0),
      updated_at: utcNow()
    };
    await atomicWriteJson(this.statePath(taskId, workspaceKey), next);
    await atomicWriteText(node_path.join(this.taskDirectory(taskId, workspaceKey), "status"), `${next.status}
`);
    return next;
  }
}
const TRANSCRIPT_ROLES = /* @__PURE__ */ new Set([
  "human",
  "claude",
  "codex",
  "opencode",
  "kimi",
  "system"
]);
function transcriptEntryFromJson(value) {
  const row = objectValue(value);
  if (!row) return [];
  const role = normalizeTranscriptRole(row.role);
  const content = textValue(row.content);
  if (!role || !content) return [];
  const entry = {
    role,
    content,
    ts: textValue(row.ts) ?? "",
    meta: objectValue(row.meta) ?? {}
  };
  const seq = numberValue(row.seq);
  if (seq != null) entry.seq = seq;
  return [entry];
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function normalizeTranscriptRole(value) {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return TRANSCRIPT_ROLES.has(role) ? role : null;
}
function textValue(value) {
  return typeof value === "string" ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
async function listDirectoryNames(path2) {
  try {
    const entries = await promises.readdir(path2, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
async function readJson(path2) {
  return JSON.parse(await promises.readFile(path2, "utf8"));
}
async function readOptionalJson(path2) {
  try {
    return await readJson(path2);
  } catch {
    return {};
  }
}
async function readOptionalText(path2) {
  try {
    return await promises.readFile(path2, "utf8");
  } catch {
    return "";
  }
}
async function atomicWriteJson(path2, value) {
  await atomicWriteText(path2, stringifyJson(value));
}
async function atomicWriteText(path2, value) {
  await promises.mkdir(node_path.dirname(path2), { recursive: true });
  const tmp = `${path2}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await promises.writeFile(tmp, value);
  await promises.rename(tmp, path2);
}
async function appendEventLine(path2, event) {
  await promises.mkdir(node_path.dirname(path2), { recursive: true });
  await promises.writeFile(path2, `${stringifyJsonLine(event)}
`, { flag: "a" });
}
async function atomicAppendText(path2, value) {
  await promises.mkdir(node_path.dirname(path2), { recursive: true });
  await promises.writeFile(path2, value, { flag: "a" });
}
function defaultTaskSettings(globalSettings, overrides = {}) {
  const normalizedGlobal = normalizeGlobalSettings(globalSettings);
  const { launchers: overrideLaunchers, ...restOverrides } = overrides;
  const launchers = normalizeLaunchers({
    ...normalizedGlobal.launchers,
    ...coerceLauncherOverrides(overrideLaunchers)
  });
  return {
    protocol_version: normalizedGlobal.protocol_version ?? "1",
    countdown_seconds: normalizedGlobal.countdown_seconds ?? 30,
    flow_policy: "claude_then_codex",
    role_mode: "claude_implements",
    max_rounds: normalizedGlobal.max_rounds,
    max_consecutive_failures: normalizedGlobal.max_consecutive_failures,
    launchers,
    seed_claude_session_id: normalizedGlobal.seed_claude_session_id ?? "",
    seed_codex_thread_id: normalizedGlobal.seed_codex_thread_id ?? "",
    seed_opencode_session_id: "",
    seed_kimi_session_id: "",
    ...restOverrides
  };
}
function coerceLauncherOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const launchers = {};
  for (const [actor, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw;
    launchers[actor] = {
      command: candidate.command,
      env: candidate.env,
      timeout_seconds: candidate.timeout_seconds
    };
  }
  return launchers;
}
function isNotFoundError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function defaultTaskState(taskId, repoRoot, settings, contextText, now) {
  const initialActor = settings.implementer_actor || (settings.role_mode === "codex_implements" ? "codex" : "claude");
  return {
    protocol_version: "1",
    task_id: taskId,
    repo_root: repoRoot,
    status: "READY",
    round: 0,
    rounds_in_window: 0,
    next_actor: initialActor,
    claude_session_id: null,
    codex_thread_id: null,
    opencode_session_id: null,
    kimi_session_id: null,
    context_hash: sha256Hex(contextText),
    context_sent: Object.fromEntries(ACTORS.map((actor) => [actor, false])),
    active_run: null,
    countdown: null,
    last_error: null,
    latest_failure: null,
    event_seq: 0,
    transcript_seq: 0,
    consecutive_failures: 0,
    created_at: now,
    updated_at: now,
    pending_break: null
  };
}
function taskMarkdownContent(value) {
  return `${value.trimEnd()}
`;
}
function contextMarkdownContent(value) {
  const trimmed = value.trimEnd();
  return trimmed ? `${trimmed}
` : "";
}
function sha256Hex(value) {
  return node_crypto.createHash("sha256").update(value).digest("hex");
}
function utcNow() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function stringifyJson(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}
`;
}
function stringifyJsonLine(value) {
  return JSON.stringify(sortJsonValue(value));
}
function stringifyPythonJsonLine(value) {
  return stringifyPythonJsonValue(sortJsonValue(value));
}
function stringifyPythonJsonValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stringifyPythonJsonValue).join(", ")}]`;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value).filter(([, item]) => item !== void 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${stringifyPythonJsonValue(item)}`).join(", ")}}`;
}
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, sortJsonValue(item)])
  );
}
class BuddyCoreService {
  constructor(options = {}) {
    const normalized = typeof options === "string" ? { dataRoot: options } : options;
    this.events = normalized.events;
    this.store = new BuddyStore(normalized.dataRoot ?? defaultDataRoot());
    this.runner = new BuddyRunner(this.store);
  }
  async checkHealth() {
    return true;
  }
  async bootstrap() {
    return {
      version: "native",
      repo_root: "",
      data_root: this.store.dataRoot,
      tasks: await this.store.getTasks(),
      global_settings: await this.store.readGlobalSettings()
    };
  }
  getTasks() {
    return this.store.getTasks();
  }
  getTaskDetail(taskId, workspaceKey) {
    if (!workspaceKey) throw new Error("workspaceKey is required");
    return this.store.getTaskDetail(taskId, workspaceKey);
  }
  createTask(input) {
    return this.store.createTask(input);
  }
  deleteTask(taskId, workspaceKey) {
    if (!workspaceKey) throw new Error("workspaceKey is required");
    return this.store.deleteTask(taskId, workspaceKey);
  }
  async startTask(taskId, input) {
    await this.runner.startTask(taskId, input);
  }
  sendMessage(taskId, input) {
    return this.runner.sendMessage(taskId, input);
  }
  async skipCountdown(taskId, input) {
    await this.runner.skipCountdown(taskId, input);
  }
  pauseCountdown(taskId, input) {
    return this.runner.pauseCountdown(taskId, input);
  }
  interrupt(taskId, workspaceKey) {
    if (!workspaceKey) throw new Error("workspaceKey is required");
    return this.runner.interrupt(taskId, workspaceKey);
  }
  getEvents(taskId, since, workspaceKey) {
    if (!workspaceKey) throw new Error("workspaceKey is required");
    return this.store.getEvents(taskId, since, workspaceKey);
  }
  updateGlobalSettings(settings) {
    return this.store.updateGlobalSettings(settings);
  }
  async recoverInterruptedRuns() {
    const tasks = await this.store.getTasks();
    for (const task of tasks) {
      if (task.status.startsWith("RUNNING_")) {
        const event = await this.store.appendTaskEvent(task.task_id, task.workspace_key, {
          type: "actor.interrupted",
          payload: { reason: "app_restarted" }
        });
        await this.store.updateTaskState(task.task_id, task.workspace_key, (state) => ({
          ...state,
          status: "PAUSED",
          active_run: null,
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }));
        this.events?.publish({
          workspace_key: task.workspace_key,
          task_id: task.task_id,
          event
        });
      }
    }
  }
}
function defaultDataRoot() {
  return node_path.join(node_os.homedir(), "Library", "Application Support", "buddy");
}
class BuddyEventBus {
  constructor() {
    this.subscribers = /* @__PURE__ */ new Set();
  }
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }
  publish(event) {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
  publishToWindow(window, event) {
    window.webContents.send("buddy:event", event);
  }
}
const windowManager = new WindowManager();
const buddyEvents = new BuddyEventBus();
const buddyService = new BuddyCoreService({ events: buddyEvents });
electron.app.setName("Buddy");
registerBuddyHandlers(electron.ipcMain, buddyService);
buddyEvents.subscribe((event) => {
  windowManager.getMainWindow()?.webContents.send("buddy:event", event);
});
electron.app.whenReady().then(async () => {
  await buddyService.recoverInterruptedRuns();
  windowManager.createWindow();
  electron.ipcMain.handle("dialog:selectDirectory", async (_event, defaultPath) => {
    const win = windowManager.getMainWindow();
    const result = win ? await electron.dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      defaultPath
    }) : await electron.dialog.showOpenDialog({
      properties: ["openDirectory"],
      defaultPath
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle("window:isFullScreen", () => {
    return windowManager.getMainWindow()?.isFullScreen() ?? false;
  });
  electron.ipcMain.handle("shell:openInFinder", async (_event, path2) => {
    await electron.shell.openPath(path2);
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
