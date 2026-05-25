import { useEffect, useRef, useState } from 'react'

const runningHints = [
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

const dotsPhases = ['', '.', '..', '...']

function pickRandomHint(): string {
  return runningHints[Math.floor(Math.random() * runningHints.length)]
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

function actorClass(actor: string): string {
  if (actor === 'claude') return 'msg-claude'
  if (actor === 'codex') return 'msg-codex'
  if (actor === 'opencode') return 'msg-opencode'
  if (actor === 'kimi') return 'msg-kimi'
  return 'msg-default'
}

function actorLabel(actor: string): string {
  const map: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', kimi: 'Kimi' }
  return map[actor] || actor
}

export function RunningStatusMessage({ actor, startedAt, round }: { actor: string; startedAt: string; round?: number }) {
  const [hint, setHint] = useState(pickRandomHint)
  const [dots, setDots] = useState(0)
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt))
  const tickRef = useRef(0)

  useEffect(() => {
    const interval = setInterval(() => {
      tickRef.current += 1
      setDots(prev => (prev + 1) % dotsPhases.length)
      setElapsed(formatElapsed(startedAt))
      if (tickRef.current % 10 === 0) {
        setHint(pickRandomHint())
      }
    }, 400)
    return () => clearInterval(interval)
  }, [startedAt])

  const metaParts: string[] = []
  if (round && round > 0) metaParts.push(`第 ${round} 轮`)
  metaParts.push(`运行中 · ${elapsed}`)

  return (
    <div className="flex mb-3 justify-start">
      <div className={`message w-full ${actorClass(actor)} running-status`}>
        <div className="message-head">
          <span className="role">{actorLabel(actor)}</span>
          <span>{metaParts.join(' · ')}</span>
        </div>
        <div className="running-status-body">
          {hint}{dotsPhases[dots]}
        </div>
      </div>
    </div>
  )
}
