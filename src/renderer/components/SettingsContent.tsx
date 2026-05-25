import { useEffect, useState } from 'react'
import { useTheme, Theme } from '../hooks/useTheme'
import { useUpdateGlobalSettings } from '../hooks/useBuddy'
import type { GlobalSettings, Launcher } from '../../shared/types'

export type SettingsTab = 'general' | 'appearance'

interface SettingsContentProps {
  tab: SettingsTab
  globalSettings: GlobalSettings | null
}

const PAGE_TITLE: Record<SettingsTab, string> = {
  general: '常规',
  appearance: '外观'
}

const LAUNCHER_ORDER: string[] = ['claude', 'codex', 'opencode', 'kimi']

const LAUNCHER_INFO: Record<string, { title: string; label: string; placeholder: string; hint: React.ReactNode }> = {
  claude: {
    title: 'Claude 配置',
    label: 'Claude 启动命令',
    placeholder: 'claude --dangerously-skip-permissions',
    hint: (
      <>
        Claude Code 的启动命令。作为执行方时推荐使用 <Code>--dangerously-skip-permissions</Code>。
      </>
    )
  },
  codex: {
    title: 'Codex 配置',
    label: 'Codex 启动命令',
    placeholder: 'codex',
    hint: (
      <>
        Codex 的启动命令。launcher 会自动使用 <Code>exec --dangerously-bypass-approvals-and-sandbox</Code> 非交互模式执行。
      </>
    )
  },
  opencode: {
    title: 'OpenCode 配置',
    label: 'OpenCode 启动命令',
    placeholder: 'opencode',
    hint: (
      <>
        OpenCode 的启动命令。launcher 会自动使用 <Code>run --format json --dangerously-skip-permissions</Code> 非交互模式执行。
      </>
    )
  },
  kimi: {
    title: 'Kimi 配置',
    label: 'Kimi 启动命令',
    placeholder: 'kimi',
    hint: (
      <>
        Kimi CLI 的启动命令。launcher 会自动使用 <Code>--print --output-format stream-json --input-format text</Code> 非交互模式执行（<Code>--print</Code> 隐式启用 <Code>--afk</Code> 自动批准）。
      </>
    )
  }
}

export function SettingsContent({ tab, globalSettings }: SettingsContentProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-bg-elevated">
      <div className="max-w-4xl mx-auto px-10 py-10">
        <h1 className="text-2xl font-semibold mb-8">{PAGE_TITLE[tab]}</h1>
        {tab === 'general' ? (
          <GeneralSettings globalSettings={globalSettings} />
        ) : (
          <AppearanceSettings />
        )}
      </div>
    </div>
  )
}

function GeneralSettings({ globalSettings }: { globalSettings: GlobalSettings | null }) {
  const updateMutation = useUpdateGlobalSettings()
  const launchers = globalSettings?.launchers ?? {}

  const buildBase = (): GlobalSettings => ({
    protocol_version: globalSettings?.protocol_version ?? '1',
    countdown_seconds: globalSettings?.countdown_seconds ?? 30,
    max_rounds: globalSettings?.max_rounds ?? 10,
    max_consecutive_failures: globalSettings?.max_consecutive_failures ?? 3,
    launchers: globalSettings?.launchers ?? {}
  })

  const save = (patch: Partial<GlobalSettings>) => {
    updateMutation.mutate({ ...buildBase(), ...patch })
  }

  const saveLauncher = (actor: string, patch: Partial<Launcher>) => {
    const cur = launchers[actor] ?? { command: '', env: {}, timeout_seconds: 7200 }
    const next = { ...cur, ...patch, env: cur.env }
    save({ launchers: { ...launchers, [actor]: next } })
  }

  const saveAllTimeouts = (timeout: number) => {
    const nextLaunchers: Record<string, Launcher> = {}
    for (const [actor, l] of Object.entries(launchers)) {
      nextLaunchers[actor] = { ...l, timeout_seconds: timeout, env: l.env }
    }
    save({ launchers: nextLaunchers })
  }

  const currentTimeout =
    LAUNCHER_ORDER.map((a) => launchers[a]?.timeout_seconds).find((v) => typeof v === 'number') ?? 7200

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-semibold text-fg mb-1">CLI 配置</h2>
        <p className="text-sm text-fg-secondary mb-5">配置默认的启动命令和协作参数。新建任务时会使用这些设置作为默认值。</p>
      </div>

      {LAUNCHER_ORDER.some((a) => launchers[a]) && (
        <SettingsList>
          {LAUNCHER_ORDER.map((actor) => {
            const launcher = launchers[actor]
            if (!launcher) return null
            return (
              <LauncherSection
                key={actor}
                actor={actor}
                launcher={launcher}
                info={LAUNCHER_INFO[actor]}
                onSaveCommand={(command) => saveLauncher(actor, { command })}
              />
            )
          })}
        </SettingsList>
      )}

      <div className="pt-4">
        <h2 className="text-base font-semibold text-fg mb-1">默认协作参数</h2>
        <p className="text-sm text-fg-secondary mb-3">新建任务时使用的默认参数</p>
        <SettingsList>
          <SettingsRow
            title="倒计时（秒）"
            description="角色切换前的等待时间"
            right={
              <EditableNumber
                value={globalSettings?.countdown_seconds ?? 30}
                min={0}
                max={600}
                onSave={(v) => save({ countdown_seconds: v })}
              />
            }
          />
          <SettingsRow
            title="自动轮次"
            description="单个任务的最大协作轮数"
            right={
              <EditableNumber
                value={globalSettings?.max_rounds ?? 10}
                min={1}
                max={50}
                onSave={(v) => save({ max_rounds: v })}
              />
            }
          />
          <SettingsRow
            title="启动命令超时（秒）"
            description="启动命令运行的最长时间，所有 CLI 共用"
            right={
              <EditableNumber
                value={currentTimeout}
                min={60}
                max={86400}
                onSave={saveAllTimeouts}
              />
            }
          />
        </SettingsList>
      </div>
    </div>
  )
}

function LauncherSection({ actor, launcher, info, onSaveCommand }: {
  actor: string
  launcher: Launcher
  info: { title: string; label: string; placeholder: string; hint: React.ReactNode }
  onSaveCommand: (command: string) => void
}) {
  const saved = launcher.command || ''
  const [draft, setDraft] = useState(saved)

  useEffect(() => {
    setDraft(saved)
  }, [saved])

  const dirty = draft !== saved

  return (
    <div className="px-4 py-4">
      <div className="flex items-center gap-2 mb-1">
        <ActorBadge actor={actor} />
        <h2 className="text-base font-semibold text-fg">{info.title}</h2>
        <button
          type="button"
          onClick={() => onSaveCommand(draft)}
          disabled={!dirty}
          className="ml-auto px-3 py-1 text-xs font-medium rounded-md bg-accent text-fg-inverse hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          保存
        </button>
      </div>
      <p className="text-sm text-fg-secondary mb-3 leading-relaxed">{info.hint}</p>
      <div className="text-xs font-medium text-fg-secondary mb-1.5">{info.label}</div>
      <input
        type="text"
        value={draft}
        placeholder={info.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty) {
            e.preventDefault()
            onSaveCommand(draft)
          }
          if (e.key === 'Escape') {
            setDraft(saved)
          }
        }}
        className="w-full px-3 py-2 text-sm bg-transparent border border-border rounded-lg font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
      />
      {Object.keys(launcher.env).length > 0 && (
        <div className="mt-2 text-xs text-fg-muted font-mono">
          {Object.entries(launcher.env).map(([k, v]) => (
            <div key={k}>{k}={v}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()

  const themeOptions: { value: Theme; label: string; description: string }[] = [
    { value: 'light', label: '浅色', description: '始终使用浅色外观' },
    { value: 'dark', label: '深色', description: '始终使用深色外观' },
    { value: 'system', label: '系统', description: '跟随系统设置' },
  ]

  return (
    <div className="space-y-10">
      <SettingsSection title="主题" description="选择应用的外观主题">
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((opt) => {
            const active = theme === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => setTheme(opt.value)}
                className={`relative p-4 rounded-xl border bg-bg-elevated text-left transition-colors ${
                  active
                    ? 'border-accent ring-1 ring-accent'
                    : 'border-border hover:border-fg-muted'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <ThemeIcon theme={opt.value} active={active} />
                  <span className="text-sm font-medium">{opt.label}</span>
                </div>
                <div className="text-xs text-fg-muted">{opt.description}</div>
                <div
                  className={`absolute top-3 right-3 w-4 h-4 rounded-full border-2 ${
                    active ? 'border-accent bg-accent' : 'border-border'
                  }`}
                >
                  {active && (
                    <div className="absolute inset-0 m-auto w-1.5 h-1.5 rounded-full bg-fg-inverse" />
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </SettingsSection>
    </div>
  )
}

function ThemeIcon({ theme, active }: { theme: Theme; active: boolean }) {
  const color = active ? 'var(--accent)' : 'var(--fg-muted)'
  if (theme === 'light') {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={color} strokeWidth="2">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    )
  }
  if (theme === 'dark') {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={color} strokeWidth="2">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={color} strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

function SettingsSection({ title, description, children }: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-3">
        <div className="text-base font-semibold text-fg">{title}</div>
        {description && (
          <div className="text-sm text-fg-secondary mt-1">{description}</div>
        )}
      </div>
      {children}
    </div>
  )
}

function SettingsList({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-bg-elevated divide-y divide-border-subtle overflow-hidden">
      {children}
    </div>
  )
}

function SettingsRow({ title, description, right }: {
  title: string
  description?: string
  right: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">{title}</div>
        {description && (
          <div className="text-xs text-fg-muted mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{right}</div>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-bg-subtle px-1.5 py-0.5 rounded text-xs font-mono text-fg">{children}</code>
  )
}

function EditableNumber({ value, min, max, onSave }: {
  value: number
  min: number
  max: number
  onSave: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    const clamped = Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : value))
    if (clamped !== value) onSave(clamped)
    setDraft(String(clamped))
  }

  return (
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setDraft(String(value))
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="w-20 px-2 py-1 text-sm text-fg font-mono text-right bg-transparent border border-transparent hover:border-border focus:border-accent focus:bg-bg rounded outline-none transition-colors"
    />
  )
}

function ActorBadge({ actor }: { actor: string }) {
  const colors: Record<string, string> = {
    claude: '#8b6dba',
    codex: '#4a9bb5',
    opencode: '#d97706',
    kimi: '#2e7d32',
  }
  const color = colors[actor] ?? 'var(--fg-muted)'
  return (
    <div
      className="w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  )
}
