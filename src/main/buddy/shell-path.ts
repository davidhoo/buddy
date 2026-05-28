import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INSTALL_HINTS: Record<string, string> = {
  kimi: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  opencode: 'go install github.com/sst/opencode@latest'
}

export function installHintFor(command: string): string | undefined {
  return INSTALL_HINTS[command]
}

export function fixShellPath(): void {
  if (process.platform !== 'darwin') return
  if (process.env.NODE_ENV === 'test') return
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const path = execSync(`${shell} -il -c 'echo "$PATH"' 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim()
    if (path && path !== process.env.PATH) {
      process.env.PATH = path
    }
  } catch {
    const home = homedir()
    const extras = [
      join(home, '.kimi-code/bin'),
      join(home, '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.npm-global/bin'),
      join(home, '.cargo/bin')
    ]
    const current = (process.env.PATH ?? '').split(':')
    const merged = [...new Set([...extras, ...current])]
    process.env.PATH = merged.join(':')
  }
}
