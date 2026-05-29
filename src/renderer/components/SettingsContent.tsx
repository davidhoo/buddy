import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { HexColorPicker } from 'react-colorful'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, CircleArrowOutUpLeft, Command, CornerDownLeft, Delete, Monitor, Moon, Option, RotateCcw, Search, Space, Sun } from 'lucide-react'
import { useTheme, ThemeMode } from '../hooks/useTheme'
import { getThemesByType, getThemeById, BuddyTheme } from '../themes'
import { useUpdateGlobalSettings } from '../hooks/useBuddy'
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
import { DEFAULT_LAUNCHER_ORDER, defaultLauncherFor, normalizeGlobalSettings } from '../../shared/defaults'

export type SettingsTab = 'general' | 'appearance' | 'keyboard'

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
        placeholder: 'claude --dangerously-skip-permissions',
        hint: <HintWithCode template={t('settings.launcher.claude.hint')} />
      }
    case 'codex':
      return {
        title: t('settings.launcher.codex.title'),
        label: t('settings.launcher.codex.label'),
        placeholder: 'codex',
        hint: <HintWithCode template={t('settings.launcher.codex.hint')} />
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
      : t('settings.tab.keyboard')
  return (
    <div className="flex-1 overflow-y-auto bg-bg-elevated">
      <div className="max-w-4xl mx-auto px-10 py-10">
        <h1 className="text-2xl font-semibold mb-8">{pageTitle}</h1>
        {tab === 'general' ? (
          <GeneralSettings globalSettings={globalSettings} />
        ) : tab === 'appearance' ? (
          <AppearanceSettings />
        ) : (
          <KeyboardSettings />
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
            <select
              value={pref}
              onChange={(e) => setPref(e.target.value as LanguagePref)}
              className="px-2 py-1 text-sm bg-bg border border-border rounded-md focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.value === 'auto' ? `${opt.label} (${detectedLabel})` : opt.label}
                </option>
              ))}
            </select>
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
          return (
            <LauncherSection
              key={actor}
              actor={actor}
              launcher={launcher}
              info={launcherInfoFor(actor, t)}
              onSaveCommand={(command) => saveLauncher(actor, { command })}
            />
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
        </SettingsList>
      </div>
    </div>
  )
}

function LauncherSection({ actor, launcher, info, onSaveCommand }: {
  actor: string
  launcher: Launcher
  info: LauncherInfo
  onSaveCommand: (command: string) => void
}) {
  const t = useT()
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
      </div>
      <p className="text-sm text-fg-secondary mb-3 leading-relaxed">{info.hint}</p>
      <div className="text-xs font-medium text-fg-secondary mb-1.5">{info.label}</div>
      <div className="flex items-center gap-2">
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
          className="flex-1 px-3 py-2 text-sm bg-transparent border border-border rounded-lg font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
        />
        <button
          type="button"
          onClick={() => onSaveCommand(draft)}
          disabled={!dirty}
          className="px-3 py-2 text-xs font-medium rounded-md bg-accent-primary text-fg-inverse hover:bg-accent-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {t('common.save')}
        </button>
      </div>
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
      className="w-20 px-2 py-1 text-sm text-fg font-mono text-right bg-transparent border border-transparent hover:border-border focus:border-accent focus:bg-bg rounded outline-none transition-colors"
    />
  )
}

function ActorBadge({ actor }: { actor: string }) {
  const map: Record<string, string> = {
    claude: 'var(--actor-claude)',
    codex: 'var(--actor-codex)',
    opencode: 'var(--actor-opencode)',
    kimi: 'var(--actor-kimi)',
  }
  return (
    <div
      className="w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: map[actor] ?? 'var(--fg-muted)' }}
    />
  )
}
