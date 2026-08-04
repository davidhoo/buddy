import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandKindFor, isWecodeClaudeCommand, isWecodeCodexCommand } from './launchers'

/**
 * Detect the current model for an actor by reading its configuration file.
 * This serves as a fallback when the model cannot be determined from
 * streaming output events.
 *
 * Detection is driven by the launcher command's *kind* (the actual CLI being
 * invoked), not the actor name — so e.g. an actor named "kimi" whose launcher
 * is `opencode -m provider/kimi-k2.6` is detected as opencode, matching what
 * the runner will actually invoke.
 *
 * Precedence:
 * 1. `-m` / `--model` passed on the command line (always wins — it is exactly
 *    what the runner invokes, for any CLI).
 * 2. CLI-specific config file:
 *    - opencode: ~/.config/opencode/opencode.json → JSON "model" field
 *    - codex:    ~/.codex/config.toml → TOML "model" field
 *      (when launched via `wecode codex`, reads ~/.wecode-cli/config.json → codex.model instead)
 *    - kimi:     ~/.kimi-code/config.toml → TOML "default_model" field
 *      (~/.kimi/config.toml is checked as a legacy fallback)
 *    - claude:   ~/.claude/settings.json → env.ANTHROPIC_MODEL, else "model" field
 *      (the "model" field is a tier alias like "sonnet[1m]"; ANTHROPIC_MODEL is the
 *       real model the SDK invokes, so it takes precedence to match what runs)
 *      (when launched via WeCode — `wecode` without a leading `codex` token —
 *       reads ~/.wecode-cli/config.json → env.ANTHROPIC_MODEL instead, and does
 *       NOT fall back to ~/.claude/settings.json)
 *
 * @param actor  Actor name (codex, opencode, kimi, claude)
 * @param command  Optional launcher command string. Used both to extract an
 *                 explicit `-m`/`--model` override and to determine the CLI
 *                 kind (e.g. distinguishing `wecode codex` from plain `codex`,
 *                 or `opencode` invoked under a kimi/codex actor).
 */
export async function detectModelFromConfig(
  actor: string,
  command?: string
): Promise<string | undefined> {
  try {
    // 1. An explicit -m / --model on the command line always wins, for any CLI.
    const fromCommand = modelFromCommandArgs(command)
    if (fromCommand) return fromCommand

    // 2. Otherwise branch on the actual CLI kind, not the actor name.
    const kind = commandKindFor(actor, command ?? '')
    const home = homedir()

    if (kind === 'native_opencode') {
      return await readJsonModel(join(home, '.config', 'opencode', 'opencode.json'), 'model')
    }
    if (kind === 'native_codex') {
      // When codex is launched via `wecode codex`, the effective model is
      // in ~/.wecode-cli/config.json (codex.model), NOT ~/.codex/config.toml
      // — wecode does not write back to config.toml.
      if (isWecodeCodexCommand(command ?? '')) {
        return await readWecodeCodexModel(home)
      }
      return await readTomlModel(join(home, '.codex', 'config.toml'), 'model')
    }
    if (kind === 'native_kimi') {
      // Kimi Code CLI reads ~/.kimi-code/config.toml; ~/.kimi is the legacy path
      const primary = await readTomlModel(join(home, '.kimi-code', 'config.toml'), 'default_model').catch(() => undefined)
      if (primary) return primary
      return await readTomlModel(join(home, '.kimi', 'config.toml'), 'default_model')
    }
    if (kind === 'native_claude') {
      // WeCode Claude (`wecode`, optionally with flags like
      // --dangerously-skip-permissions) reads its own config and must NOT
      // fall back to ~/.claude/settings.json — otherwise a stale Claude model
      // would be displayed. Detection is by executable basename, not by any
      // permission flag, mirroring commandKindFor.
      if (isWecodeClaudeCommand(command ?? '')) {
        return await readWecodeClaudeModel(join(home, '.wecode-cli', 'config.json'))
      }
      return await readClaudeModel(join(home, '.claude', 'settings.json'))
    }
    // contract: model is not knowable before a run.
  } catch {
    // Config file may not exist or be unreadable — that's fine
  }
  return undefined
}

/**
 * Extract the model from a launcher command's `-m` / `--model` argument,
 * e.g. `opencode -m agnes/agnes-2.0-flash` → `agnes/agnes-2.0-flash`,
 * or `codex -m gpt-5.6-luna` → `gpt-5.6-luna`. Applies to any CLI kind —
 * a command-line override is always what the runner actually invokes.
 */
function modelFromCommandArgs(command?: string): string | undefined {
  if (!command) return undefined
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)
  if (!parts) return undefined
  const clean = parts.map((p) => p.replace(/^"|"$/g, ''))
  for (let i = 0; i < clean.length; i++) {
    if (clean[i].startsWith('--model=')) {
      return clean[i].slice('--model='.length) || undefined
    }
    if ((clean[i] === '-m' || clean[i] === '--model') && i + 1 < clean.length) {
      return clean[i + 1] || undefined
    }
  }
  return undefined
}

/**
 * Read the codex model from ~/.wecode-cli/config.json.
 * Structure: { codex: { model: "thudm-glm-5.2", forceModel: false } }
 */
async function readWecodeCodexModel(home: string): Promise<string | undefined> {
  const raw = await readFile(join(home, '.wecode-cli', 'config.json'), 'utf8')
  const obj = JSON.parse(raw) as Record<string, unknown>
  const codex = obj.codex
  if (codex && typeof codex === 'object') {
    const model = (codex as Record<string, unknown>).model
    if (typeof model === 'string' && model) return model
  }
  return undefined
}

/**
 * Read the effective WeCode Claude model from ~/.wecode-cli/config.json.
 * Structure: { env: { ANTHROPIC_MODEL: "weibo-glm-5.2[1m]" } }
 *
 * WeCode does not write back to ~/.claude/settings.json, so when the launcher
 * is `wecode` this is the only source of truth. Any failure (missing file,
 * unreadable, malformed JSON, absent/non-string/empty ANTHROPIC_MODEL) yields
 * undefined — no fallback to the plain-Claude config.
 */
async function readWecodeClaudeModel(filePath: string): Promise<string | undefined> {
  const raw = await readFile(filePath, 'utf8')
  const obj = JSON.parse(raw) as Record<string, unknown>
  const env = obj.env
  if (env && typeof env === 'object') {
    const override = (env as Record<string, unknown>).ANTHROPIC_MODEL
    if (typeof override === 'string' && override) return override
  }
  return undefined
}

/**
 * Read the effective Claude model from ~/.claude/settings.json.
 *
 * Claude Code's `model` field is a tier alias (e.g. "sonnet[1m]", "opus").
 * The actual model the SDK invokes is `env.ANTHROPIC_MODEL` when set — it
 * overrides the tier at the SDK level. Prefer it so the displayed model
 * matches what the runner really invokes; fall back to the `model` alias.
 */
async function readClaudeModel(filePath: string): Promise<string | undefined> {
  const raw = await readFile(filePath, 'utf8')
  const obj = JSON.parse(raw) as Record<string, unknown>
  const env = obj.env
  if (env && typeof env === 'object') {
    const override = (env as Record<string, unknown>).ANTHROPIC_MODEL
    if (typeof override === 'string' && override) return override
  }
  const model = obj.model
  return typeof model === 'string' && model ? model : undefined
}

/**
 * Read a model field from a JSON config file.
 */
async function readJsonModel(filePath: string, field: string): Promise<string | undefined> {
  const raw = await readFile(filePath, 'utf8')
  const obj = JSON.parse(raw) as Record<string, unknown>
  const value = obj[field]
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Extract a top-level string field from a TOML config file.
 * Uses a simple regex instead of a full TOML parser since we only
 * need a single top-level key.
 *
 * Handles: key = "value", key = 'value', key = value
 */
async function readTomlModel(filePath: string, field: string): Promise<string | undefined> {
  const raw = await readFile(filePath, 'utf8')
  // Match top-level field only: no leading whitespace, no dot in key path
  // Patterns: model = "gpt-5.5" | model = 'gpt-5.5' | model = gpt-5.5
  const re = new RegExp(`^${field}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))`, 'm')
  const match = re.exec(raw)
  if (!match) return undefined
  const value = match[1] ?? match[2] ?? match[3]
  return value?.trim() || undefined
}
