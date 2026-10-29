import { Terminal } from 'lucide-react'
import claudeCode from '../../assets/agent-icons/claudecode-color.svg'
import claude from '../../assets/agent-icons/claude-color.svg'
import codex from '../../assets/agent-icons/codex-color.svg'
import antigravity from '../../assets/agent-icons/antigravity-color.svg'
import opencode from '../../assets/agent-icons/opencode.svg'
import cursor from '../../assets/agent-icons/cursor.svg'
import kimi from '../../assets/agent-icons/kimi.svg'
import deepseek from '../../assets/agent-icons/deepseek-color.svg'
import zed from '../../assets/agent-icons/zed.svg'
import vscode from '../../assets/agent-icons/vscode.svg'
import workbuddy from '../../assets/agent-icons/workbuddy-color.svg'
import codebuddy from '../../assets/agent-icons/codebuddy-color.svg'
import gemini from '../../assets/agent-icons/geminicli-color.svg'
import openai from '../../assets/agent-icons/openai.svg'

const icons: Record<string, { url: string; color?: boolean }> = {
  claude: { url: claudeCode, color: true }, claude_desktop: { url: claude, color: true },
  codex: { url: codex, color: true }, agy: { url: antigravity, color: true },
  opencode: { url: opencode }, cursor: { url: cursor }, kimi: { url: kimi },
  dsh: { url: deepseek, color: true }, zed: { url: zed }, vscode: { url: vscode },
  workbuddy: { url: workbuddy, color: true }, codebuddy: { url: codebuddy, color: true },
  gemini: { url: gemini, color: true }, openai: { url: openai }
}
export function AgentIcon({ id, model, size = 20 }: { id: string; model?: string; size?: number }) {
  let key = id.replace(/^wecode_/, '')
  if (model) {
    const family = model.split('/').pop()?.toLowerCase() || ''
    if (/^(gpt|o[134]|codex)/.test(family)) key = 'openai'
    else if (family.startsWith('claude')) key = 'claude_desktop'
    else if (family.startsWith('deepseek')) key = 'dsh'
    else if (/^(kimi|moonshot)/.test(family)) key = 'kimi'
    else if (family.startsWith('gemini')) key = 'gemini'
  }
  const icon = icons[key]
  if (!icon) return <Terminal aria-hidden="true" size={size} />
  return icon.color
    ? <img data-agent-icon={key} className="agent-brand-icon" src={icon.url} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
    : <span data-agent-icon={key} className="agent-brand-icon agent-brand-mask" aria-hidden="true" style={{ width: size, height: size, maskImage: `url("${icon.url}")`, WebkitMaskImage: `url("${icon.url}")` }} />
}
