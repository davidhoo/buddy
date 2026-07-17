import { spawn } from 'node:child_process'
import type {
  CursorModel,
  CursorModelCatalog,
  CursorModelDiscoveryInput
} from '../../shared/types'
import { splitCommand } from './launchers'

const CURSOR_MODELS_URL = 'https://api.cursor.com/v1/models'
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g

interface CursorModelsApiResponse {
  items?: CursorModel[]
}

/**
 * Discover the account's model catalog. The official Cursor models endpoint is
 * the same catalog exposed by Cursor.models.list(), but works in Electron's
 * Node 20 runtime (the current SDK package requires Node 22.13+). A logged-in
 * Cursor Agent CLI is used as a credential-free fallback.
 */
export async function discoverCursorModels(
  input: CursorModelDiscoveryInput = {}
): Promise<CursorModelCatalog> {
  const apiKey = input.apiKey?.trim()
    || input.env?.CURSOR_API_KEY?.trim()
    || process.env.CURSOR_API_KEY?.trim()
  let apiWarning: string | undefined

  if (apiKey) {
    try {
      const models = await fetchCursorModelsFromApi(apiKey)
      return {
        models,
        source: 'cursor-api',
        fetchedAt: new Date().toISOString()
      }
    } catch (error) {
      apiWarning = errorMessage(error)
    }
  }

  try {
    const cliEnv = { ...(input.env ?? {}) }
    if (apiWarning && /HTTP (?:401|403)\b/.test(apiWarning)) {
      // A rejected key would override the CLI's valid local login. Empty it so
      // Cursor Agent can fall back to its authenticated account session.
      cliEnv.CURSOR_API_KEY = ''
    }
    const models = await fetchCursorModelsFromCli(
      input.command?.trim() || 'agent',
      cliEnv
    )
    return {
      models,
      source: 'cli',
      fetchedAt: new Date().toISOString(),
      ...(apiWarning ? { warning: `Cursor API failed; used CLI fallback: ${apiWarning}` } : {})
    }
  } catch (cliError) {
    const parts = [
      apiWarning ? `Cursor API: ${apiWarning}` : undefined,
      `Cursor CLI: ${errorMessage(cliError)}`
    ].filter(Boolean)
    throw new Error(`Unable to discover Cursor models. ${parts.join(' | ')}`)
  }
}

export async function fetchCursorModelsFromApi(apiKey: string): Promise<CursorModel[]> {
  const response = await fetch(CURSOR_MODELS_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
    }
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
  }
  const body = await response.json() as CursorModelsApiResponse
  const models = normalizeModels(body.items)
  if (models.length === 0) throw new Error('model catalog was empty')
  return models
}

export async function fetchCursorModelsFromCli(
  command: string,
  env?: Record<string, string>
): Promise<CursorModel[]> {
  const [executable, ...prefixArgs] = splitCommand(command)
  if (!executable) throw new Error('Cursor Agent command is empty')
  const output = await captureCommand(executable, [...prefixArgs, '--list-models'], env)
  const models = parseCursorModelList(output)
  if (models.length === 0) throw new Error('CLI returned no parseable models')
  return models
}

export function parseCursorModelList(output: string): CursorModel[] {
  const seen = new Set<string>()
  const models: CursorModel[] = []
  for (const rawLine of output.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const separator = line.indexOf(' - ')
    const id = (separator >= 0 ? line.slice(0, separator) : line).trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/+-]*$/.test(id) || seen.has(id)) continue
    const rawName = separator >= 0 ? line.slice(separator + 3).trim() : id
    const displayName = rawName
      .replace(/\s+\((?:default|current)\)(?=\s|$)/gi, '')
      .trim() || id
    seen.add(id)
    models.push({ id, displayName })
  }
  return models
}

function normalizeModels(input: unknown): CursorModel[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const model = value as CursorModel
    if (typeof model.id !== 'string' || !model.id.trim()) return []
    return [{
      ...model,
      id: model.id.trim(),
      displayName: typeof model.displayName === 'string' && model.displayName.trim()
        ? model.displayName.trim()
        : model.id.trim()
    }]
  })
}

function captureCommand(
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      const output = Buffer.concat(stdout).toString('utf8')
      if (code === 0) {
        resolve(output)
        return
      }
      const error = Buffer.concat(stderr).toString('utf8').trim()
      reject(new Error(error || `exited with ${code ?? signal ?? 'unknown status'}`))
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
