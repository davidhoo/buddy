import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, PanelBottomOpen } from 'lucide-react'
import type { TaskSettings } from '../../shared/types'
import { ACTOR_LABEL_KEY, actorColorVar, actorDisplayName } from '../lib/format'
import { useLanguage, useT } from '../hooks/useI18n'
import type { ActorStreamLine } from '../hooks/useBuddy'

const HINTS_ZH_CN = [
  '解析中', '推理中', '计划中', '执行中', '检索中', '生成中', '校验中', '重构中', '合并中', '收束中',
  '捣鼓中', '整活中', '摸鱼式忙碌 ing', '花里胡哨 ing', '那啥处理 ing', '重新理顺 ing', '脑内翻炒 ing',
  '慢悠悠推进 ing', '小火慢炖 ing', '神秘运转 ing', '开搞 ing', '憋大招 ing', '疯狂脑补 ing',
  '代码蒸煮 ing', '努力圆回来 ing', 'CPU 干烧 ing', '正在玄学优化', '这就安排', '问题不大 ing', '马上就有了 ing',
  '运功 ing', '闭关 ing', '参悟 ing', '推演功法 ing', '炼丹 ing', '淬体 ing', '御剑检索 ing',
  '渡劫重构 ing', '破境生成 ing', '正在收功',
  '正在备料', '正在翻炒', '正在小火慢炖', '正在调味', '正在腌制', '正在醒面', '正在烘焙', '正在收汁', '正在装盘', '正在出锅',
  '神经脉冲 ing', '量子扰动 ing', '向量穿梭 ing', '矩阵重排 ing', '正在挥霍 token', '模型共振 ing', '意识加载 ing', '稀里糊涂 ing',
  '掀桌子了', '弄乱了', '改花了', '完蛋了', '删库了', '跑路了', '舞剑中', '耍大刀呢',
  '鼓捣猫呢', '倒腾狗呢', '琢磨甩锅呢', '推卸责任呢', '想着怎么赖对方呢',
]

const HINTS_ZH_TW = [
  '解析中', '推理中', '規劃中', '執行中', '檢索中', '生成中', '校驗中', '重構中', '合併中', '收束中',
  '搗鼓中', '整活中', '摸魚式忙碌 ing', '花裡胡哨 ing', '那啥處理 ing', '重新理順 ing', '腦內翻炒 ing',
  '慢悠悠推進 ing', '小火慢燉 ing', '神祕運轉 ing', '開搞 ing', '憋大招 ing', '瘋狂腦補 ing',
  '程式蒸煮 ing', '努力圓回來 ing', 'CPU 乾燒 ing', '正在玄學優化', '這就安排', '問題不大 ing', '馬上就有 ing',
  '運功 ing', '閉關 ing', '參悟 ing', '推演功法 ing', '煉丹 ing', '淬體 ing', '御劍檢索 ing',
  '渡劫重構 ing', '破境生成 ing', '正在收功',
  '正在備料', '正在翻炒', '正在小火慢燉', '正在調味', '正在醃漬', '正在醒麵', '正在烘焙', '正在收汁', '正在裝盤', '正在出鍋',
  '神經脈衝 ing', '量子擾動 ing', '向量穿梭 ing', '矩陣重排 ing', '正在揮霍 token', '模型共振 ing', '意識載入 ing', '稀裡糊塗 ing',
  '掀桌子了', '弄亂了', '改花了', '完蛋了', '刪庫了', '跑路了', '舞劍中', '耍大刀呢',
  '搗鼓貓呢', '倒騰狗呢', '琢磨甩鍋呢', '推卸責任呢', '想著怎麼賴對方呢',
]

const HINTS_EN = [
  'Parsing', 'Thinking', 'Planning', 'Executing', 'Searching', 'Generating', 'Validating', 'Refactoring', 'Merging', 'Wrapping up',
  'Tinkering', 'Improvising', 'Pretending to be busy', 'Adding flair', 'Doing the thing', 'Sorting it out', 'Cooking ideas',
  'Pondering slowly', 'Simmering on low', 'Mysteriously working', 'Getting started', 'Charging up', 'Hallucinating responsibly',
  'Stewing the code', 'Squaring the circle', 'CPU on fire', 'Trying mystic tweaks', 'On it', 'Should be fine', 'Almost there',
  'Channeling energy', 'In meditation', 'Studying scripture', 'Practicing form', 'Brewing elixir', 'Tempering body', 'Sword-flying through search',
  'Surviving tribulation refactor', 'Breaking through generation', 'Closing the form',
  'Prepping ingredients', 'Stir-frying', 'Slow simmering', 'Seasoning', 'Marinating', 'Resting the dough', 'Baking', 'Reducing sauce', 'Plating', 'Out of the wok',
  'Neural pulses', 'Quantum jitter', 'Vector hopping', 'Matrix shuffling', 'Burning tokens', 'Model resonance', 'Loading consciousness', 'Slightly confused',
  'Flipped the table', 'Made a mess', 'Painted it weird', "It's over", 'Dropped the DB', 'Ran away', 'Sword dance', 'Brandishing blades',
  'Petting the cat', 'Wrangling the dog', 'Plotting blame', 'Dodging responsibility', 'Drafting an excuse',
]

const dotsPhases = ['', '.', '..', '...']

function pickHint(lang: 'zh-CN' | 'zh-TW' | 'en'): string {
  const bank = lang === 'en' ? HINTS_EN : lang === 'zh-TW' ? HINTS_ZH_TW : HINTS_ZH_CN
  return bank[Math.floor(Math.random() * bank.length)]
}

function formatElapsed(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime()
  if (Number.isNaN(diff) || diff < 0) return ''
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remainSec = sec % 60
  if (min < 60) return `${min}m ${remainSec}s`
  const hour = Math.floor(min / 60)
  const remainMin = min % 60
  return `${hour}h ${remainMin}m`
}

export function RunningStatusMessage({
  actor,
  startedAt,
  settings,
  expanded,
  onToggleExpand
}: {
  actor: string
  startedAt: string
  settings?: TaskSettings | null
  round?: number
  expanded?: boolean
  onToggleExpand?: () => void
}) {
  const t = useT()
  const lang = useLanguage()
  const [hint, setHint] = useState(() => pickHint(lang))
  const [dots, setDots] = useState(0)
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt))
  const tickRef = useRef(0)

  useEffect(() => {
    setHint(pickHint(lang))
  }, [lang])

  useEffect(() => {
    const interval = setInterval(() => {
      tickRef.current += 1
      setDots(prev => (prev + 1) % dotsPhases.length)
      setElapsed(formatElapsed(startedAt))
      if (tickRef.current % 10 === 0) {
        setHint(pickHint(lang))
      }
    }, 400)
    return () => clearInterval(interval)
  }, [startedAt, lang])

  const metaText = t('running.metaSuffix', { elapsed })
  const actorLabel = settings?.launchers?.[actor]?.display_name
    || (ACTOR_LABEL_KEY[actor] ? t(ACTOR_LABEL_KEY[actor]) : actorDisplayName(actor, settings))
  const color = actorColorVar(actor, settings)

  return (
    <div className="flex justify-start">
      <div className={`message w-full running-status ${expanded ? 'running-status-expanded' : 'mb-3'}`} style={{ '--actor-color': color, borderColor: color } as React.CSSProperties}>
        <div className="message-head">
          <span className="role" style={{ color }}>{actorLabel}</span>
          <div className="flex items-center gap-2">
            <span>{metaText}</span>
            {onToggleExpand && (
              <button
                type="button"
                onClick={onToggleExpand}
                className="running-expand-btn"
                title={expanded ? t('running.collapseDetail') : t('running.expandDetail')}
              >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </div>
        </div>
        <div
          className="running-status-body"
          onClick={onToggleExpand}
          style={onToggleExpand ? { cursor: 'pointer' } : undefined}
        >
          {hint}{dotsPhases[dots]}
        </div>
      </div>
    </div>
  )
}

export function RunningDetailPanel({
  actor,
  settings,
  streamLines,
  lastMessage,
  onCollapse
}: {
  actor: string
  settings?: TaskSettings | null
  streamLines: ActorStreamLine[]
  lastMessage?: string
  onCollapse?: () => void
}) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  const isNearBottom = () => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = () => {
      userScrolledUp.current = !isNearBottom()
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [])

  useEffect(() => {
    if (scrollRef.current && !userScrolledUp.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [streamLines])

  return (
    <div className="running-detail-panel" style={{ '--actor-color': actorColorVar(actor, settings) } as React.CSSProperties}>
      <div ref={scrollRef} className="running-detail-content">
        {streamLines.length === 0 ? (
          lastMessage ? (
            <div className="running-detail-line running-detail-fallback">{lastMessage}</div>
          ) : (
            <div className="running-detail-empty">{t('running.streamingWaiting')}</div>
          )
        ) : (
          streamLines.map((line, i) => (
            <div key={i} className="running-detail-line">{line.text}</div>
          ))
        )}
      </div>
      {onCollapse && (
        <div className="running-detail-footer">
          <button
            type="button"
            onClick={onCollapse}
            className="running-detail-collapse-btn"
            title={t('running.collapseDetail')}
          >
            <PanelBottomOpen size={14} />
            <span>{t('common.collapse')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
