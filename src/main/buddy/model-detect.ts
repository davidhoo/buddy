import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Detect the current model for an actor by reading its configuration file.
 * This serves as a fallback when the model cannot be determined from
 * streaming output events.
 *
 * Config file locations:
 * - opencode: ~/.config/opencode/opencode.json  → JSON "model" field
 * - codex:    ~/.codex/config.toml              → TOML "model" field
 *   (when launched via `wecode codex`, reads ~/.wecode-cli/config.json → codex.model instead)
 * - kimi:     ~/.kimi/config.toml               → TOML "default_model" field
 * - claude:   not needed (model reliably emitted in stream-json output)
 *
 * @param actor  Actor name (codex, opencode, kimi, claude)
 * @param command  Optional launcher command string. Used to distinguish
 *                 `wecode codex` from plain `codex`.
 */
export async function detectModelFromConfig(
  actor: string,
  command?: string
): Promise<string | undefined> {
  try {
    const home = homedir()
    if (actor === 'opencode') {
      return await readJsonModel(join(home, '.config', 'opencode', 'opencode.json'), 'model')
    }
    if (actor === 'codex') {
      // When codex is launched via `wecode codex`, the effective model is
      // in ~/.wecode-cli/config.json (codex.model), NOT ~/.codex/config.toml
      // — wecode does not write back to config.toml.
      if (isWecodeCodexCommand(command)) {
        return await readWecodeCodexModel(home)
      }
      return await readTomlModel(join(home, '.codex', 'config.toml'), 'model')
    }
    if (actor === 'kimi') {
      return await readTomlModel(join(home, '.kimi', 'config.toml'), 'default_model')
    }
  } catch {
    // Config file may not exist or be unreadable — that's fine
  }
  return undefined
}

/**
 * Check whether a command string represents `wecode codex`.
 * Mirrors the detection in launchers.ts commandKindFor.
 */
function isWecodeCodexCommand(command?: string): boolean {
  if (!command) return false
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)
  if (!parts) return false
  const clean = parts.map((p) => p.replace(/^"|"$/g, ''))
  return clean[0] === 'wecode' && clean[1] === 'codex'
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
