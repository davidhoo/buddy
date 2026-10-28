import { Bot } from 'lucide-react'
import claude from '../../assets/agents/claudecode-color.svg'
import codex from '../../assets/agents/codex-color.svg'
import cursor from '../../assets/agents/cursor.svg'
import antigravity from '../../assets/agents/antigravity-color.svg'
import opencode from '../../assets/agents/opencode.svg'
import kimi from '../../assets/agents/kimi.svg'
import deepseek from '../../assets/agents/deepseek-color.svg'

// Brand assets match Magpie's library. Monochrome SVGs use a mask so they
// inherit the current theme's text color, as in Magpie's icon renderer.
const icons: Record<string, { src: string; monochrome?: boolean }> = {
  claude: { src: claude },
  codex: { src: codex },
  cursor: { src: cursor, monochrome: true },
  agy: { src: antigravity },
  opencode: { src: opencode, monochrome: true },
  kimi: { src: kimi, monochrome: true },
  dsh: { src: deepseek }
}

export function AgentIcon({ actor, active = true }: { actor: string; active?: boolean }) {
  const family = actor.replace(/^wecode_/, '')
  const icon = icons[family]
  if (!icon) return <Bot size={20} aria-hidden="true" />
  return <span aria-hidden="true" data-agent-icon={family} className={`inline-flex w-5 h-5 shrink-0 items-center justify-center ${active ? '' : 'grayscale opacity-60'}`}>
    {icon.monochrome
      ? <span className="block w-full h-full bg-current" style={{ maskImage: `url("${icon.src}")`, WebkitMaskImage: `url("${icon.src}")`, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }} />
      : <img className="block w-full h-full object-contain" src={icon.src} alt="" draggable={false} />}
  </span>
}
