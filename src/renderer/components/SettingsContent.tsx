import { useEffect, useState, useMemo, useRef, useCallback, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { HexColorPicker } from 'react-colorful'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, CircleArrowOutUpLeft, Command, CornerDownLeft, Delete, Monitor, Moon, Option, RotateCcw, Search, Space, Sun } from 'lucide-react'
import { useTheme, ThemeMode } from '../hooks/useTheme'
import { getThemesByType, getThemeById, BuddyTheme } from '../themes'
import { useUpdateGlobalSettings, useTestLauncher, useAcpGlobalAdapters } from '../hooks/useBuddy'
import type { TestLauncherResult, GlobalAcpAdaptersStatus } from '../../shared/types'
import { useLanguagePref, useSendShortcut, useT, TFunction } from '../hooks/useI18n'
import { LANGUAGE_OPTIONS, LanguagePref, SendShortcut } from '../lib/i18n'
import {
  type ShortcutId,
  type KeyBinding,
  type ShortcutDef,
  SHORTCUT_DEFS,
  getShortcutGroups,
  loadBindings,
  saveBinding,
  resetBinding,
  resetAllBindings,
  findConflict,
  formatBinding,
  bindingToParts,
  eventToBinding,
  bindingsEqual,
} from '../lib/keyboard'
import type { GlobalSettings, Launcher } from '../../shared/types'
import { DEFAULT_LAUNCHER_ORDER, KNOWN_ACP_PRESETS, defaultLauncherFor, normalizeGlobalSettings } from '../../shared/defaults'
import { actorColorVar } from '../lib/format'
import { CheckCircle, XCircle, Loader2, Zap, AlertCircle, Info, Copy, Check } from 'lucide-react'
import { Switch } from './Switch'

export type SettingsTab = 'general' | 'appearance' | 'keyboard' | 'prompts'

interface SettingsContentProps {
  tab: SettingsTab
  globalSettings: GlobalSettings | null
}

type LauncherInfo = { title: string; label: string; placeholder: string; hint: React.ReactNode }

function launcherInfoFor(actor: string, t: TFunction): LauncherInfo {
  switch (actor) {
    case 'claude':
      return {
        title: t('settings.launcher.claude.title'),
        label: t('settings.launcher.claude.label'),
        placeholder: 'claude',
        hint: <HintWithCode template={t('settings.launcher.claude.hint')} />
      }
    case 'codex':
      return {
        title: t('settings.launcher.codex.title'),
        label: t('settings.launcher.codex.label'),
        placeholder: 'codex',
        hint: <HintWithCode template={t('settings.launcher.codex.hint')} />
      }
    case 'cursor':
      return {
        title: t('settings.launcher.cursor.title'),
        label: t('settings.launcher.cursor.label'),
        placeholder: 'cursor-agent',
        hint: <HintWithCode template={t('settings.launcher.cursor.hint')} />
      }
    case 'agy':
      return {
        title: t('settings.launcher.agy.title'),
        label: t('settings.launcher.agy.label'),
        placeholder: 'agy',
        hint: <HintWithCode template={t('settings.launcher.agy.hint')} />
      }
    case 'opencode':
      return {
        title: t('settings.launcher.opencode.title'),
        label: t('settings.launcher.opencode.label'),
        placeholder: 'opencode',
        hint: <HintWithCode template={t('settings.launcher.opencode.hint')} />
      }
    case 'kimi':
      return {
        title: t('settings.launcher.kimi.title'),
        label: t('settings.launcher.kimi.label'),
        placeholder: 'kimi',
        hint: <HintWithCode template={t('settings.launcher.kimi.hint')} />
      }
    case 'wecode_claude':
      return {
        title: t('settings.launcher.wecode_claude.title'),
        label: t('settings.launcher.wecode_claude.label'),
        placeholder: 'wecode',
        hint: <HintWithCode template={t('settings.launcher.wecode_claude.hint')} />
      }
    case 'wecode_codex':
      return {
        title: t('settings.launcher.wecode_codex.title'),
        label: t('settings.launcher.wecode_codex.label'),
        placeholder: 'wecode codex',
        hint: <HintWithCode template={t('settings.launcher.wecode_codex.hint')} />
      }
    case 'wecode_opencode':
      return {
        title: t('settings.launcher.wecode_opencode.title'),
        label: t('settings.launcher.wecode_opencode.label'),
        placeholder: 'wecode opencode',
        hint: <HintWithCode template={t('settings.launcher.wecode_opencode.hint')} />
      }
    default:
      return { title: actor, label: actor, placeholder: actor, hint: '' }
  }
}

/**
 * Renders a hint string, wrapping CLI flags (tokens starting with `--` or `-` and option names like `exec`/`run`/`stream-json`)
 * in <code> tags only when they appear; here we just render plain text since we already pre-translated the hint.
 */
function HintWithCode({ template }: { template: string }) {
  return <>{template}</>
}

export function SettingsContent({ tab, globalSettings }: SettingsContentProps) {
  const t = useT()
  const pageTitle = tab === 'general'
    ? t('settings.tab.general')
    : tab === 'appearance'
      ? t('settings.tab.appearance')
      : tab === 'keyboard'
        ? t('settings.tab.keyboard')
        : t('settings.tab.prompts')
  return (
    <div className="flex-1 overflow-y-auto bg-bg-elevated">
      <div className="max-w-4xl mx-auto px-10 py-10">
        <h1 className="text-2xl font-semibold mb-8">{pageTitle}</h1>
        {tab === 'general' ? (
          <GeneralSettings globalSettings={globalSettings} />
        ) : tab === 'appearance' ? (
          <AppearanceSettings />
        ) : tab === 'keyboard' ? (
          <KeyboardSettings />
        ) : (
          <PromptsSettings globalSettings={globalSettings} />
        )}
      </div>
    </div>
  )
}

function SendShortcutSelect({
  options,
  value,
  onChange,
  current
}: {
  options: Array<{ value: SendShortcut; symbol: string; text: string; desc: string }>
  value: SendShortcut
  onChange: (v: SendShortcut) => void
  current: { symbol: string; text: string }
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })

  const updatePos = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 4, left: r.left, width: r.width })
  }, [])

  useEffect(() => {
    if (open) {
      updatePos()
      const onScroll = () => updatePos()
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', updatePos)
      return () => {
        window.removeEventListener('scroll', onScroll, true)
        window.removeEventListener('resize', updatePos)
      }
    }
  }, [open, updatePos])

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLElement)) return
      if (btnRef.current?.contains(e.target)) return
      if (e.target.closest('[data-send-dropdown]')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between gap-1.5 px-2 py-1 text-sm bg-bg border border-border rounded-md focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent min-w-[220px]"
      >
        <div className="flex items-center gap-1.5">
          <span className="w-6 text-right text-fg-muted">{current.symbol}</span>
          <span>{current.text}</span>
        </div>
        <ChevronDown size={14} className="text-fg-muted" />
      </button>
      {open && createPortal(
        <div
          data-send-dropdown
          className="fixed bg-bg border border-fg-muted/40 rounded-lg shadow-lg z-[9999] py-0.5 min-w-[220px] text-[13px]"
          style={{ top: pos.top, left: pos.left, width: btnRef.current?.getBoundingClientRect().width }}
        >
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={`w-full flex items-center gap-1.5 px-3 py-[3px] hover:bg-bg-muted rounded-[4px] mx-0.5 transition-colors ${value === opt.value ? 'text-accent' : 'text-fg'}`}
            >
              <span className="w-6 text-right text-fg-muted shrink-0">{opt.symbol}</span>
              <span>{opt.text}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

function GeneralSection() {
  const t = useT()
  const { pref, setPref, detected } = useLanguagePref()
  const { shortcut, setShortcut } = useSendShortcut()

  const detectedLabel = detected === 'zh-CN' ? '简体中文' : detected === 'zh-TW' ? '繁體中文' : 'English'

  const sendOptions: Array<{ value: SendShortcut; symbol: string; text: string; desc: string }> = [
    { value: 'shift-enter', symbol: '⇧⏎', text: t('settings.general.send.shiftEnter'), desc: t('settings.general.send.shiftEnterHint') },
    { value: 'enter', symbol: '⏎', text: t('settings.general.send.enter'), desc: t('settings.general.send.enterHint') },
    { value: 'cmd-enter', symbol: '⌘⏎', text: t('settings.general.send.cmdEnter'), desc: t('settings.general.send.cmdEnterHint') }
  ]
  const currentSend = sendOptions.find(o => o.value === shortcut) ?? sendOptions[0]

  return (
    <div>
      <h2 className="text-base font-semibold text-fg mb-1">{t('settings.general.section.title')}</h2>
      <p className="text-sm text-fg-secondary mb-5">{t('settings.general.section.desc')}</p>

      <SettingsList>
        <SettingsRow
          title={t('settings.general.language.title')}
          description={t('settings.general.language.desc')}
          right={
            <div className="relative min-w-[220px]">
              <select
                value={pref}
                onChange={(e) => setPref(e.target.value as LanguagePref)}
                className="w-full appearance-none pl-2 pr-7 py-1 text-sm bg-bg border border-border rounded-md focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.value === 'auto' ? `${opt.label} (${detectedLabel})` : opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted"
              />
            </div>
          }
        />

        <SettingsRow
          title={t('settings.general.send.title')}
          description={t('settings.general.send.desc')}
          right={
            <SendShortcutSelect
              options={sendOptions}
              value={shortcut}
              onChange={setShortcut}
              current={currentSend}
            />
          }
        />
      </SettingsList>
    </div>
  )
}

function GeneralSettings({ globalSettings }: { globalSettings: GlobalSettings | null }) {
  const t = useT()
  const updateMutation = useUpdateGlobalSettings()
  const normalizedSettings = normalizeGlobalSettings(globalSettings)
  const launchers = normalizedSettings.launchers ?? {}

  const buildBase = (): GlobalSettings => normalizedSettings

  const save = (patch: Partial<GlobalSettings>) => {
    updateMutation.mutate({ ...buildBase(), ...patch })
  }

  const saveLauncher = (actor: string, patch: Partial<Launcher>) => {
    const cur = launchers[actor] ?? defaultLauncherFor(actor)
    const next = { ...cur, ...patch, env: cur.env }
    if (!patch.protocol) {
      delete next.protocol
      delete next.args
    }
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
    DEFAULT_LAUNCHER_ORDER.map((a) => launchers[a]?.timeout_seconds).find((v) => typeof v === 'number') ?? 7200

  const { data: globalAdapters, refetch: refetchGlobalAdapters } = useAcpGlobalAdapters()

  return (
    <div className="space-y-8">
      <GeneralSection />

      <div className="pt-2">
        <h2 className="text-base font-semibold text-fg mb-1">{t('settings.cli.title')}</h2>
        <p className="text-sm text-fg-secondary mb-5">{t('settings.cli.desc')}</p>
      </div>

      <SettingsList>
        {DEFAULT_LAUNCHER_ORDER.map((actor) => {
          const launcher = launchers[actor] ?? defaultLauncherFor(actor)
          const isFirstWecode = actor === 'wecode_claude'
          return (
            <Fragment key={actor}>
              {isFirstWecode && (
                <div className="px-4 py-2 bg-bg-subtle/50 flex items-center gap-2.5 select-none">
                  <div className="h-px bg-border-subtle flex-1" />
                  <span className="text-[11px] text-fg-muted font-medium tracking-wide">
                    {t('settings.launcher.internalToolsHeader')}
                  </span>
                  <div className="h-px bg-border-subtle flex-1" />
                </div>
              )}
              <LauncherSection
                actor={actor}
                launcher={launcher}
                info={launcherInfoFor(actor, t)}
                onSave={(patch) => saveLauncher(actor, patch)}
                globalAdapters={globalAdapters}
                onRefreshAdapters={() => {
                  void refetchGlobalAdapters()
                }}
              />
            </Fragment>
          )
        })}
      </SettingsList>

      <div className="pt-4">
        <h2 className="text-base font-semibold text-fg mb-1">{t('settings.collab.title')}</h2>
        <p className="text-sm text-fg-secondary mb-3">{t('settings.collab.desc')}</p>
        <SettingsList>
          <SettingsRow
            title={t('settings.collab.maxRounds.title')}
            description={t('settings.collab.maxRounds.desc')}
            right={
              <EditableNumber
                value={globalSettings?.max_rounds ?? 9999}
                min={-1}
                max={999999}
                onSave={(v) => save({ max_rounds: v })}
              />
            }
          />
          <SettingsRow
            title={t('settings.collab.timeout.title')}
            description={t('settings.collab.timeout.desc')}
            right={
              <EditableNumber
                value={currentTimeout}
                min={60}
                max={86400}
                onSave={saveAllTimeouts}
              />
            }
          />
          <SettingsRow
            title={t('settings.collab.maxFailures.title')}
            description={t('settings.collab.maxFailures.desc')}
            right={
              <EditableNumber
                value={globalSettings?.max_consecutive_failures ?? 10}
                min={1}
                max={999}
                onSave={(v) => save({ max_consecutive_failures: v })}
              />
            }
          />
          <SettingsRow
            title={t('settings.collab.autoGenerateCommit.title')}
            description={t('settings.collab.autoGenerateCommit.desc')}
            right={
              <Switch
                checked={normalizedSettings.auto_generate_commit_message ?? true}
                onChange={(v) => save({ auto_generate_commit_message: v })}
                ariaLabel={t('settings.collab.autoGenerateCommit.title')}
              />
            }
          />
          <SettingsRow
            title={t('settings.collab.systemNotifications.title')}
            description={t('settings.collab.systemNotifications.desc')}
            right={
              <Switch
                checked={normalizedSettings.system_notifications_enabled ?? true}
                onChange={(v) => save({ system_notifications_enabled: v })}
                ariaLabel={t('settings.collab.systemNotifications.title')}
              />
            }
          />
        </SettingsList>
      </div>
    </div>
  )
}

function PromptsSettings({ globalSettings }: { globalSettings: GlobalSettings | null }) {
  const t = useT()
  const updateMutation = useUpdateGlobalSettings()
  const normalizedSettings = normalizeGlobalSettings(globalSettings)
  const saved = normalizedSettings.custom_prompt ?? ''

  const save = (patch: Partial<GlobalSettings>) => {
    updateMutation.mutate({ ...normalizedSettings, ...patch })
  }

  const [draft, setDraft] = useState(saved)

  useEffect(() => {
    setDraft(normalizedSettings.custom_prompt ?? '')
  }, [normalizedSettings.custom_prompt])

  const dirty = draft !== saved

  const handleSave = () => {
    save({ custom_prompt: draft.trim() || undefined })
  }

  const handleReset = () => {
    if (!window.confirm(t('settings.prompts.resetConfirm'))) return
    setDraft('')
    save({ custom_prompt: undefined })
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-fg mb-1">{t('settings.prompts.title')}</h2>
        <p className="text-sm text-fg-secondary">{t('settings.prompts.desc')}</p>
      </div>

      <SettingsList>
        <div className="px-4 py-4">
          <div className="text-sm font-medium text-fg mb-2">{t('settings.prompts.customLabel')}</div>
          <textarea
            value={draft}
            rows={8}
            placeholder={t('settings.prompts.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-transparent border border-border rounded-lg font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors resize-y"
          />
        </div>
      </SettingsList>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty}
          className="px-3 py-2 text-xs font-medium rounded-md bg-accent-primary text-fg-inverse hover:bg-accent-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {t('common.save')}
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-border hover:bg-bg-subtle transition-colors"
        >
          <RotateCcw size={12} />
          {t('settings.prompts.resetToDefault')}
        </button>
      </div>
    </div>
  )
}

function LauncherSection({
  actor,
  launcher,
  info,
  onSave,
  globalAdapters,
  onRefreshAdapters
}: {
  actor: string
  launcher: Launcher
  info: LauncherInfo
  onSave: (patch: Partial<Launcher>) => void
  globalAdapters?: GlobalAcpAdaptersStatus
  onRefreshAdapters?: () => void
}) {
  const t = useT()
  const savedProtocol = launcher.protocol === 'acp' ? 'acp' : 'cli'
  const savedCommand = launcher.command || ''
  const savedArgs = (launcher.args ?? []).join(' ')

  const [protocol, setProtocol] = useState<'cli' | 'acp'>(savedProtocol)
  const [commandDraft, setCommandDraft] = useState(savedCommand)
  const [argsDraft, setArgsDraft] = useState(savedArgs)
  const [copied, setCopied] = useState(false)

  const adapter =
    actor === 'claude' || actor === 'wecode_claude'
      ? globalAdapters?.claude
      : actor === 'codex' || actor === 'wecode_codex'
      ? globalAdapters?.codex
      : undefined

  useEffect(() => {
    setProtocol(savedProtocol)
    const initialCommand =
      savedProtocol === 'cli' && (savedCommand === 'npx' || savedCommand.includes('acp') || !savedCommand.trim())
        ? defaultLauncherFor(actor).command
        : savedCommand
    setCommandDraft(initialCommand)
    setArgsDraft(savedArgs)
  }, [savedProtocol, savedCommand, savedArgs, actor])

  const dirty =
    protocol !== savedProtocol ||
    commandDraft !== savedCommand ||
    (protocol === 'acp' && argsDraft !== savedArgs)

  const [testResult, setTestResult] = useState<TestLauncherResult | null>(null)
  const testLauncherMutation = useTestLauncher()

  const directBin =
    actor === 'claude' || actor === 'wecode_claude'
      ? 'claude-agent-acp'
      : actor === 'codex' || actor === 'wecode_codex'
      ? 'codex-acp'
      : undefined

  const actorPresets = useMemo(() => {
    const rawPresets = KNOWN_ACP_PRESETS.filter((p) => p.actor === actor)
    if (adapter?.installed && directBin) {
      return rawPresets.map((preset) => {
        if (preset.command === 'npx') {
          return {
            ...preset,
            command: directBin,
            args: [],
            description: `${preset.name} (${directBin})`
          }
        }
        return preset
      })
    }
    return rawPresets
  }, [actor, adapter?.installed, directBin])

  const applyAcpPreset = useCallback(
    (preset?: (typeof actorPresets)[number]) => {
      const target = preset ?? actorPresets[0]
      if (!target) return
      setCommandDraft(target.command)
      setArgsDraft(target.args.join(' '))
    },
    [actorPresets]
  )

  const isNpxAcpDraft =
    commandDraft === 'npx' || commandDraft.endsWith('/npx') || commandDraft.includes('/npx')

  const commandDraftRef = useRef(commandDraft)
  commandDraftRef.current = commandDraft

  // If ACP was selected with the npx fallback and a global adapter appears later,
  // upgrade the draft to the direct binary automatically.
  useEffect(() => {
    if (protocol !== 'acp' || !adapter?.installed || !directBin) return
    const current = commandDraftRef.current
    const stillNpx = current === 'npx' || current.endsWith('/npx') || current.includes('/npx')
    if (!stillNpx) return
    setCommandDraft(directBin)
    setArgsDraft('')
  }, [protocol, adapter?.installed, directBin])

  const handleSave = () => {
    const trimmedCommand = commandDraft.trim()
    const trimmedArgs = argsDraft.trim()
    const patch: Partial<Launcher> = {
      command: trimmedCommand || defaultLauncherFor(actor).command,
      protocol: protocol === 'acp' ? 'acp' : undefined,
      args: protocol === 'acp' && trimmedArgs ? trimmedArgs.split(/\s+/) : undefined
    }
    onSave(patch)
  }

  const handleTest = () => {
    setTestResult(null)
    const trimmedArgs = argsDraft.trim()
    testLauncherMutation.mutate(
      {
        actor,
        command: commandDraft.trim(),
        env: launcher.env,
        protocol,
        args: protocol === 'acp' && trimmedArgs ? trimmedArgs.split(/\s+/) : undefined
      },
      {
        onSuccess: (result) => setTestResult(result),
        onError: (err) => {
          setTestResult({
            actor,
            success: false,
            phase: 'tool_check',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    )
  }

  return (
    <div className="px-4 py-4">
      <div className="flex items-center gap-2 mb-1">
        <ActorBadge actor={actor} />
        <h2 className="text-base font-semibold text-fg">{info.title}</h2>
        {savedProtocol === 'acp' && (
          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
            ACP
          </span>
        )}
      </div>
      <p className="text-sm text-fg-secondary mb-3 leading-relaxed">
        {protocol === 'acp' ? t('settings.launcher.acpHint') : info.hint}
      </p>

      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg-secondary">{t('settings.launcher.mode')}:</span>
          <div className="inline-flex rounded-lg p-0.5 bg-bg-muted border border-border">
            <button
              type="button"
              onClick={() => {
                setProtocol('cli')
                if (commandDraft === 'npx' || commandDraft.includes('acp') || !commandDraft.trim()) {
                  setCommandDraft(defaultLauncherFor(actor).command)
                }
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                protocol === 'cli'
                  ? 'bg-bg-elevated text-fg shadow-sm'
                  : 'text-fg-secondary hover:text-fg'
              }`}
            >
              {t('settings.launcher.modeCli')}
            </button>
            <button
              type="button"
              onClick={() => {
                setProtocol('acp')
                applyAcpPreset()
                onRefreshAdapters?.()
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                protocol === 'acp'
                  ? 'bg-bg-elevated text-purple-600 dark:text-purple-400 shadow-sm font-semibold'
                  : 'text-fg-secondary hover:text-fg'
              }`}
            >
              {t('settings.launcher.modeAcp')}
            </button>
          </div>
        </div>

        {actorPresets.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-fg-muted">{t('settings.launcher.presets')}:</span>
            {actorPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setProtocol('acp')
                  applyAcpPreset(preset)
                }}
                className="px-2 py-0.5 text-[11px] rounded border border-border/80 hover:border-purple-500/50 hover:bg-purple-500/5 text-fg-secondary hover:text-fg transition-colors"
                title={preset.description}
              >
                {preset.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {protocol === 'acp' && adapter && (
        adapter.installed ? (
          <div className="mb-3 px-3 py-2.5 rounded-lg text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Zap size={14} className="shrink-0 text-emerald-500" />
              <span className="leading-relaxed">
                {t('settings.launcher.globalAdapterReady', { bin: adapter.binaryPath ?? directBin ?? '' })}
              </span>
            </div>
            {directBin && isNpxAcpDraft && (
              <button
                type="button"
                onClick={() => {
                  setCommandDraft(directBin)
                  setArgsDraft('')
                }}
                className="shrink-0 px-2.5 py-1 text-[11px] font-medium rounded border border-emerald-500/30 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-800 dark:text-emerald-200 flex items-center gap-1 transition-colors"
              >
                <Zap size={12} />
                {t('settings.launcher.switchToDirect', { bin: directBin })}
              </button>
            )}
          </div>
        ) : (
          <div className="mb-3 p-3 rounded-lg text-xs bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 text-amber-900 dark:text-amber-200">
            <div className="flex items-center gap-2 font-medium mb-1 text-amber-800 dark:text-amber-300">
              <Zap size={15} className="text-amber-600 dark:text-amber-400 shrink-0" />
              <span>{t('settings.launcher.globalInstallPromptTitle')}</span>
            </div>
            <p className="text-fg-secondary text-[11px] mb-2 leading-relaxed">
              {t('settings.launcher.globalInstallPromptDesc')}
            </p>
            <div className="flex items-center justify-between gap-2 bg-bg/60 dark:bg-bg/40 border border-amber-500/20 rounded-md px-2.5 py-1.5 font-mono text-[11px]">
              <span className="text-fg select-all truncate">{adapter.installCommand}</span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(adapter.installCommand).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 3000)
                  })
                }}
                className="shrink-0 px-2 py-1 text-[11px] font-sans font-medium rounded border border-border/80 bg-bg hover:bg-bg-subtle text-fg flex items-center gap-1 transition-colors"
                title={adapter.installCommand}
              >
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                <span>{copied ? t('common.copied') : t('settings.launcher.copyInstallCmd')}</span>
              </button>
            </div>
          </div>
        )
      )}

      {protocol === 'acp' && (actor === 'agy' || actor === 'kimi') && (
        <div className="mb-3 px-3 py-2 rounded-lg text-xs bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 flex items-start gap-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>
            {actor === 'agy'
              ? t('settings.launcher.agyAcpWarning')
              : t('settings.launcher.kimiAcpWarning')}
          </span>
        </div>
      )}

      {protocol === 'cli' ? (
        <>
          <div className="text-xs font-medium text-fg-secondary mb-1.5">{info.label}</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={commandDraft}
              placeholder={info.placeholder}
              onChange={(e) => setCommandDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty) {
                  e.preventDefault()
                  handleSave()
                }
                if (e.key === 'Escape') {
                  setCommandDraft(savedCommand)
                }
              }}
              className="flex-1 px-3 py-2 text-sm bg-transparent border border-border rounded-lg font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty}
              className="px-3 py-2 text-xs font-medium rounded-md bg-accent-primary text-fg-inverse hover:bg-accent-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={!commandDraft.trim() || testLauncherMutation.isPending}
              className="px-3 py-2 text-xs font-medium rounded-md border border-border hover:bg-bg-subtle disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap flex items-center gap-1.5"
              title={t('settings.launcher.test')}
            >
              {testLauncherMutation.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Zap size={12} />
              )}
              {testLauncherMutation.isPending ? t('settings.launcher.testing') : t('settings.launcher.test')}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <div>
            <div className="text-xs font-medium text-fg-secondary mb-1.5">{info.label}</div>
            <input
              type="text"
              value={commandDraft}
              placeholder={info.placeholder}
              onChange={(e) => setCommandDraft(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-transparent border border-border rounded-lg font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            />
          </div>
          <div>
            <div className="text-xs font-medium text-fg-secondary mb-1.5">{t('settings.launcher.args')}</div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={argsDraft}
                placeholder={t('settings.launcher.argsPlaceholder')}
                onChange={(e) => setArgsDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirty) {
                    e.preventDefault()
                    handleSave()
                  }
                }}
                className="flex-1 px-3 py-2 text-sm bg-transparent border border-border rounded-lg font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty}
                className="px-3 py-2 text-xs font-medium rounded-md bg-accent-primary text-fg-inverse hover:bg-accent-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                {t('common.save')}
              </button>
              <button
                type="button"
                onClick={handleTest}
                disabled={!commandDraft.trim() || testLauncherMutation.isPending}
                className="px-3 py-2 text-xs font-medium rounded-md border border-border hover:bg-bg-subtle disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap flex items-center gap-1.5"
                title={t('settings.launcher.test')}
              >
                {testLauncherMutation.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Zap size={12} />
                )}
                {testLauncherMutation.isPending ? t('settings.launcher.testing') : t('settings.launcher.test')}
              </button>
            </div>
          </div>
        </div>
      )}

      {testResult && (
        <div className={`mt-3 px-3 py-2 rounded-lg text-xs leading-relaxed ${
          testResult.success
            ? 'bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400'
            : 'bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400'
        }`}>
          <div className="flex items-center gap-1.5 mb-1 font-medium">
            {testResult.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
            {testResult.success ? t('settings.launcher.testPassed') : t('settings.launcher.testFailed')}
          </div>
          {testResult.phase === 'tool_check' && !testResult.success && (
            <div className="text-fg-secondary">{t('settings.launcher.toolCheckFailed')}</div>
          )}
          {testResult.error && (
            <div className="mt-1 font-mono text-[11px] break-all opacity-80">{testResult.error}</div>
          )}
          {testResult.success && testResult.responsePreview && (
            <div className="mt-1">
              <span className="text-fg-secondary">{t('settings.launcher.testResponse')}：</span>
              <span className="opacity-80">{testResult.responsePreview}</span>
            </div>
          )}
        </div>
      )}
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

function ColorPickerPopup({
  color,
  onChange,
  onClose,
  anchorRef,
}: {
  color: string
  onChange: (color: string) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
}) {
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [onClose, anchorRef])

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[9999] rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl"
      style={{
        top: anchorRef.current
          ? anchorRef.current.getBoundingClientRect().bottom + 6
          : 0,
        left: anchorRef.current
          ? anchorRef.current.getBoundingClientRect().left
          : 0,
      }}
    >
      <div>
        <HexColorPicker color={color} onChange={onChange} />
      </div>
    </div>,
    document.body,
  )
}

function ColorBar({
  label,
  color,
  isCustom,
  onChange,
  onReset,
  resetLabel,
}: {
  label: string
  color: string
  isCustom: boolean
  onChange: (value: string) => void
  onReset: () => void
  resetLabel: string
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const circleRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const displayColor = color.toUpperCase()

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.select()
    }
  }, [editing])

  const commitEdit = () => {
    const val = editValue.trim()
    const hex = val.startsWith('#') ? val : `#${val}`
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      onChange(hex)
    }
    setEditing(false)
  }

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2"
    >
      <button
        ref={circleRef}
        type="button"
        className="w-6 h-6 rounded-full border border-border flex-shrink-0 cursor-pointer transition-shadow hover:shadow-[0_0_0_2px_var(--accent)]"
        style={{ backgroundColor: color }}
        onClick={() => setPickerOpen((v) => !v)}
        aria-label={`Pick ${label} color`}
      />
      <span className="text-sm text-fg flex-shrink-0 w-12">{label}</span>
      <div className="flex-1" />
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="w-[72px] text-xs font-mono text-fg bg-bg-subtle border border-border rounded px-1.5 py-0.5 text-right outline-none focus:border-accent"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value.toUpperCase())}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') setEditing(false)
          }}
          maxLength={7}
        />
      ) : (
        <span
          className="text-xs font-mono text-fg-muted cursor-pointer hover:text-fg transition-colors"
          onClick={() => {
            setEditValue(displayColor)
            setEditing(true)
          }}
          title="点击编辑色值"
        >
          {displayColor}
        </span>
      )}
      {isCustom && (
        <button
          type="button"
          onClick={onReset}
          className="text-[10px] text-fg-muted hover:text-accent transition-colors ml-1"
          title={resetLabel}
        >
          <RotateCcw size={12} />
        </button>
      )}
      {pickerOpen && (
        <ColorPickerPopup
          color={color}
          onChange={onChange}
          onClose={() => setPickerOpen(false)}
          anchorRef={circleRef}
        />
      )}
    </div>
  )
}

function AppearanceSettings() {
  const t = useT()
  const {
    mode,
    themeId,
    custom,
    resolvedMode,
    setMode,
    setThemeId,
    setCustom,
    resetCustom,
  } = useTheme()

  const availableThemes = useMemo(() => getThemesByType(resolvedMode), [resolvedMode])
  const currentBaseTheme = useMemo(() => {
    const found = getThemeById(themeId)
    if (found && found.type === resolvedMode) return found
    return availableThemes[0]
  }, [themeId, resolvedMode, availableThemes])

  const handleSelectTheme = (id: string) => {
    setThemeId(id)
  }

  const handleColorChange = (key: CustomColorKey, value: string) => {
    setCustom({ [key]: value } as Partial<Pick<BuddyTheme, CustomColorKey>>)
  }

  const handleResetColor = (key: CustomColorKey) => {
    const next = { ...custom }
    delete (next as Record<string, unknown>)[key]
    setCustom(next)
  }

  const handleContrastChange = (value: number) => {
    setCustom({ contrast: value })
  }

  const themeOptions: { value: ThemeMode; label: string; description: string }[] = [
    { value: 'light', label: t('settings.appearance.theme.light.label'), description: t('settings.appearance.theme.light.desc') },
    { value: 'dark', label: t('settings.appearance.theme.dark.label'), description: t('settings.appearance.theme.dark.desc') },
    { value: 'system', label: t('settings.appearance.theme.system.label'), description: t('settings.appearance.theme.system.desc') },
  ]

  type CustomColorKey = 'surface' | 'ink' | 'accent' | 'success' | 'danger'
  const colorKeys: Array<{ key: CustomColorKey; labelKey: string }> = [
    { key: 'surface', labelKey: 'settings.appearance.custom.surface' },
    { key: 'ink', labelKey: 'settings.appearance.custom.ink' },
    { key: 'accent', labelKey: 'settings.appearance.custom.accent' },
    { key: 'success', labelKey: 'settings.appearance.custom.success' },
    { key: 'danger', labelKey: 'settings.appearance.custom.danger' },
  ]

  const currentContrast = custom.contrast ?? currentBaseTheme.contrast

  return (
    <div className="space-y-10">
      {/* Theme Mode */}
      <SettingsSection title={t('settings.appearance.theme.title')} description={t('settings.appearance.theme.desc')}>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((opt) => {
            const active = mode === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => setMode(opt.value)}
                className={`relative p-4 rounded-xl border bg-bg-elevated text-left transition-colors ${active
                  ? 'border-accent-primary ring-1 ring-accent-primary'
                  : 'border-border hover:border-fg-muted'
                  }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <ThemeIcon theme={opt.value} active={active} />
                  <span className="text-sm font-medium">{opt.label}</span>
                </div>
                <div className="text-xs text-fg-muted">{opt.description}</div>
                <div
                  className={`absolute top-3 right-3 w-4 h-4 rounded-full border-2 ${active ? 'border-accent-primary bg-accent-primary' : 'border-border'
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

      {/* Color Scheme */}
      <SettingsSection title={t('settings.appearance.scheme.title')} description={t('settings.appearance.scheme.desc')}>
        <div className="grid grid-cols-8 gap-2">
          {availableThemes.map((theme) => {
            const active = themeId === theme.id
            return (
              <button
                key={theme.id}
                onClick={() => handleSelectTheme(theme.id)}
                title={theme.name}
                className={`relative p-2 rounded-lg border text-left transition-colors ${active
                  ? 'border-accent-primary ring-1 ring-accent-primary'
                  : 'border-border hover:border-fg-muted'
                  }`}
                style={{ backgroundColor: theme.surface }}
              >
                <div className="h-6 rounded mb-1.5 flex items-end gap-1 px-0.5 pb-0.5">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: theme.accent }} />
                  <div className="flex-1 h-0.5 rounded" style={{ backgroundColor: theme.ink }} />
                </div>
                <div className="text-[10px] font-medium truncate" style={{ color: theme.ink }}>
                  {theme.name}
                </div>
                {active && (
                  <div className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full border-2 flex items-center justify-center"
                    style={{ borderColor: theme.accent, backgroundColor: theme.accent }}
                  >
                    <div className="w-1 h-1 rounded-full" style={{ backgroundColor: theme.surface }} />
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </SettingsSection>

      {/* Custom Colors */}
      <SettingsSection title={t('settings.appearance.custom.title')} description={t('settings.appearance.custom.desc')}>
        <div className="flex flex-col gap-2">
          {colorKeys.map(({ key, labelKey }) => {
            const value = (custom[key] as string | undefined) ?? (currentBaseTheme[key] as string)
            const isCustom = custom[key] !== undefined
            return (
              <ColorBar
                key={key}
                label={t(labelKey as any)}
                color={value}
                isCustom={isCustom}
                onChange={(v) => handleColorChange(key, v)}
                onReset={() => handleResetColor(key)}
                resetLabel={t('settings.appearance.custom.reset')}
              />
            )
          })}
        </div>
      </SettingsSection>

      {/* Contrast */}
      <SettingsSection title={t('settings.appearance.contrast.title')} description={t('settings.appearance.contrast.desc')}>
        <div className="px-1">
          <input
            type="range"
            min={0}
            max={100}
            value={currentContrast}
            onChange={(e) => handleContrastChange(Number(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs text-fg-muted mt-1">
            <span>{t('settings.appearance.contrast.low')}</span>
            <span className="font-mono">{currentContrast}</span>
            <span>{t('settings.appearance.contrast.high')}</span>
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}

function KeyboardSettings() {
  const t = useT()
  const [query, setQuery] = useState('')
  const [bindings, setBindings] = useState(() => loadBindings())
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null)
  const [conflictId, setConflictId] = useState<ShortcutId | null>(null)

  const normalizedQuery = query.trim().toLowerCase()
  const groups = getShortcutGroups()
  const visibleDefs = SHORTCUT_DEFS.filter(def => !def.hidden)

  const handleSaveBinding = useCallback((id: ShortcutId, binding: KeyBinding) => {
    // Check conflict
    const conflict = findConflict(binding, id)
    if (conflict) {
      setConflictId(conflict)
      return
    }
    setConflictId(null)
    const newMap = saveBinding(id, binding)
    setBindings(newMap)
    setRecordingId(null)
  }, [])

  const handleResetBinding = useCallback((id: ShortcutId) => {
    const newMap = resetBinding(id)
    setBindings(newMap)
    setConflictId(null)
  }, [])

  const handleResetAll = useCallback(() => {
    if (!window.confirm(t('shortcuts.resetAllConfirm'))) return
    const newMap = resetAllBindings()
    setBindings(newMap)
    setConflictId(null)
    setRecordingId(null)
  }, [t])

  // Filter shortcuts by search query
  const filteredDefs = normalizedQuery
    ? visibleDefs.filter(def => {
      const label = t(def.labelKey as Parameters<TFunction>[0]).toLowerCase()
      const keys = formatBinding(bindings[def.id]).toLowerCase()
      const groupLabel = t(groups.find(g => g.group === def.group)?.labelKey as Parameters<TFunction>[0]).toLowerCase()
      return label.includes(normalizedQuery) || keys.includes(normalizedQuery) || groupLabel.includes(normalizedQuery)
    })
    : visibleDefs

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search
            size={15}
            strokeWidth={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('shortcuts.search')}
            className="w-full h-10 pl-9 pr-3 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        <button
          onClick={handleResetAll}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-border hover:bg-bg-subtle transition-colors"
        >
          <RotateCcw size={12} />
          {t('shortcuts.resetAll')}
        </button>
      </div>

      <div className="rounded-xl border border-border bg-bg-elevated overflow-hidden">
        {groups.map(({ group, labelKey }) => {
          const groupDefs = filteredDefs.filter(d => d.group === group)
          if (groupDefs.length === 0) return null
          return (
            <div key={group}>
              <div className="px-4 pt-4 pb-2 text-xs font-medium text-fg-muted bg-bg-elevated border-t border-border-subtle first:border-t-0">
                {t(labelKey as Parameters<TFunction>[0])}
              </div>
              {groupDefs.map(def => (
                <ShortcutRow
                  key={def.id}
                  def={def}
                  binding={bindings[def.id]}
                  isRecording={recordingId === def.id}
                  conflictId={recordingId === def.id ? conflictId : null}
                  isModified={!bindingsEqual(bindings[def.id], def.defaultBinding)}
                  onStartRecording={() => { setRecordingId(def.id); setConflictId(null) }}
                  onSave={handleSaveBinding}
                  onReset={handleResetBinding}
                  onCancelRecording={() => { setRecordingId(null); setConflictId(null) }}
                  t={t}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ShortcutRow({ def, binding, isRecording, conflictId, isModified, onStartRecording, onSave, onReset, onCancelRecording, t }: {
  def: ShortcutDef
  binding: KeyBinding
  isRecording: boolean
  conflictId: ShortcutId | null
  isModified: boolean
  onStartRecording: () => void
  onSave: (id: ShortcutId, binding: KeyBinding) => void
  onReset: (id: ShortcutId) => void
  onCancelRecording: () => void
  t: TFunction
}) {
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isRecording) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        onCancelRecording()
        return
      }
      const newBinding = eventToBinding(e)
      if (newBinding) {
        onSave(def.id, newBinding)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [isRecording, def.id, onSave, onCancelRecording])

  const conflictLabel = conflictId
    ? t((SHORTCUT_DEFS.find(d => d.id === conflictId)?.labelKey ?? conflictId) as Parameters<TFunction>[0])
    : null

  return (
    <div
      ref={rowRef}
      className={`grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-4 py-3 border-t border-border-subtle items-center ${isRecording ? 'bg-bg-subtle' : ''
        }`}
    >
      <div className="min-w-0">
        <div className="text-sm text-fg">{t(def.labelKey as Parameters<TFunction>[0])}</div>
        {isRecording && (
          <div className="text-xs text-accent mt-0.5">{t('shortcuts.recordHint')}</div>
        )}
        {conflictId && conflictLabel && (
          <div className="text-xs text-danger mt-0.5">
            {t('shortcuts.conflict', { name: conflictLabel })}
          </div>
        )}
      </div>
      <div className="flex items-center">
        <button
          onClick={def.readonly ? undefined : onStartRecording}
          className={`flex items-center gap-[3px] rounded-md px-2 py-1 transition-colors ${isRecording
            ? 'ring-1 ring-accent bg-accent/10'
            : 'hover:bg-bg-subtle'
            } ${def.readonly ? 'cursor-default' : 'cursor-pointer'}`}
        >
          {bindingToParts(binding).map((part, i) => (
            <KeyCap key={i} part={part} highlighted={isRecording} />
          ))}
        </button>
      </div>
      <div className="flex items-center">
        {isModified && !def.readonly && (
          <button
            onClick={() => onReset(def.id)}
            title={t('shortcuts.resetToDefault')}
            className="p-1 rounded hover:bg-bg-subtle text-fg-muted hover:text-fg transition-colors"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

const KEY_ICON_SIZE = 12

const ICON_KEYS = new Set(['meta', 'alt', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', ' '])

function KeyCapIcon({ partKey }: { partKey: string }) {
  const props = { size: KEY_ICON_SIZE, strokeWidth: 2 }
  switch (partKey) {
    case 'meta': return <Command {...props} />
    case 'alt': return <Option {...props} />
    case 'Enter': return <CornerDownLeft {...props} />
    case 'Escape': return <CircleArrowOutUpLeft {...props} />
    case 'ArrowUp': return <ArrowUp {...props} />
    case 'ArrowDown': return <ArrowDown {...props} />
    case 'ArrowLeft': return <ArrowLeft {...props} />
    case 'ArrowRight': return <ArrowRight {...props} />
    case 'Backspace': return <Delete {...props} />
    case ' ': return <Space {...props} />
    default: return null
  }
}

function KeyCap({ part, highlighted }: { part: import('../lib/keyboard').KeyPart; highlighted: boolean }) {
  const hasIcon = ICON_KEYS.has(part.key)
  const showLabelWithIcon = part.key === 'Escape'

  return (
    <kbd
      className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-[5px] border text-[11px] font-sans leading-none select-none ${
        highlighted
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-border-subtle bg-bg-muted text-fg-secondary shadow-[0_1px_0_0_var(--border)]'
      }`}
    >
      {hasIcon ? (
        <>
          <KeyCapIcon partKey={part.key} />
          {showLabelWithIcon && <span className="ml-1">Escape</span>}
        </>
      ) : part.label}
    </kbd>
  )
}

function ThemeIcon({ theme, active }: { theme: ThemeMode; active: boolean }) {
  const color = active ? 'var(--accent)' : 'var(--fg-muted)'
  if (theme === 'light') {
    return <Sun size={16} color={color} strokeWidth={2} />
  }
  if (theme === 'dark') {
    return <Moon size={16} color={color} strokeWidth={2} />
  }
  return <Monitor size={16} color={color} strokeWidth={2} />
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
            ; (e.target as HTMLInputElement).blur()
        }
      }}
      className="w-20 px-2 py-1 text-sm text-fg font-mono text-right bg-bg border border-border hover:border-accent focus:border-accent focus:ring-1 focus:ring-accent rounded outline-none transition-colors"
    />
  )
}

function ActorBadge({ actor }: { actor: string }) {
  return (
    <div
      className="w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: actorColorVar(actor) }}
    />
  )
}
