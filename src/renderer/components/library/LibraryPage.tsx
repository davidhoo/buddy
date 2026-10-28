import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Archive, FolderOpen, HeartPulse, RefreshCw, Search, Settings } from 'lucide-react'
import type { AssignBlock, DiscoveredInstance, ExtensionActionRequest, ExtensionActionResult, LibraryItem, LibrarySection, ResolvedTarget, ScanProblem, ScanStatus, TargetBinding, TargetNote, TargetScan } from '../../../shared/extensions'
import { isImportableFoundInstance } from '../../../shared/extensions'
import { FEATURED_MCPS } from '../../../shared/mcp-catalog'
import { FEATURED_SKILLS, catalogRepositoryKey } from '../../../shared/skill-catalog'
import { useExtensionLibrary, useExtensionPage, useExtensionTargets } from '../../hooks/useBuddy'
import { useT } from '../../hooks/useI18n'
import type { TFunction } from '../../hooks/useI18n'
import type { TranslationKey } from '../../lib/i18n'
import { api } from '../../lib/api'
import { LibraryResourceList } from './LibraryResourceList'
import { ACTOR_LABEL_KEY } from '../../lib/format'

interface LibraryPageProps {
  section: LibrarySection
  cwd?: string
  taskId?: string | null
  workspaceKey?: string | null
  onOpenLauncherSettings: () => void
}

const STATUS_KEY: Record<ScanStatus, TranslationKey> = {
  ok: 'library.status.ok',
  empty: 'library.status.empty',
  uninitialized: 'library.status.uninitialized',
  read_failed: 'library.status.read_failed',
  partial: 'library.status.partial',
  unsupported: 'library.status.unsupported',
  unrecognized: 'library.status.unrecognized'
}

const NOTE_KEY: Record<TargetNote, TranslationKey> = {
  acp_codex_home: 'library.note.acp_codex_home',
  program_differs_from_actor: 'library.note.program_differs',
  wecode_family_unverified: 'library.note.wecode_unverified',
  desktop_skills_not_attributed: 'library.note.desktop_not_attributed',
  assign_not_ready: 'library.note.assign_not_ready',
  execution_env_not_scanned: 'library.note.execution_env'
}

const PROBLEM_KEY: Record<string, TranslationKey> = {
  uninitialized: 'library.problem.uninitialized',
  read_failed: 'library.problem.read_failed',
  broken_link: 'library.problem.broken_link',
  parse_failed: 'library.problem.parse_failed',
  truncated: 'library.problem.truncated',
  too_large: 'library.problem.too_large',
  not_directory: 'library.problem.not_directory',
  stat_failed: 'library.problem.stat_failed'
}

export function LibraryPage({ section, cwd, taskId, workspaceKey, onOpenLauncherSettings }: LibraryPageProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [source, setSource] = useState('')
  const [located, setLocated] = useState<DiscoveredInstance[]>([])
  const base = {
    cwd: cwd || undefined,
    taskId: taskId || undefined,
    workspaceKey: workspaceKey || undefined
  }
  const targets = useExtensionTargets(section === 'agents' ? base : null)
  const page = useExtensionPage(section === 'skills' || section === 'mcp'
    ? { ...base, kind: section === 'mcp' ? 'mcp' as const : 'skill' as const }
    : null)
  const kind = section === 'mcp' ? 'mcp' as const : 'skill' as const
  const plan = useMutation({
    mutationFn: (action: ExtensionActionRequest) => api.planExtensionAction({ ...base, ...action }),
    onSuccess: (result, variables) => {
      if (variables.action !== 'read') setNotice(actionNotice(result, t, variables.action))
      if (result.found) setLocated(result.found)
      if (result.results.some((entry) => entry.status === 'changed')) {
        setLocated([])
        void queryClient.invalidateQueries({ queryKey: ['extensions'] })
      }
    },
    onError: () => setNotice(t('library.error.generic'))
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['extensions'] })
  }

  const openLibrary = async (which: 'dir' | 'backup') => {
    try {
      const location = await api.ensureExtensionLibraryDir()
      if (which === 'backup' && location.backupCount === 0) setNotice(t('library.backup.none'))
      await window.api.openInFinder(which === 'backup' ? location.backupDir : location.dir)
    } catch (error) {
      console.error(error)
      setNotice(t('library.error.generic'))
    }
  }

  if (section === 'instructions' || section === 'hooks' || section === 'subagents') {
    return (
      <ManagedLibraryPanel
        kind={section === 'instructions' ? 'instruction' : section === 'hooks' ? 'hook' : 'subagent'}
        cwd={cwd}
        taskId={taskId}
        workspaceKey={workspaceKey}
        notice={notice}
        setNotice={setNotice}
        plan={plan}
        refresh={refresh}
        openLibrary={openLibrary}
        t={t}
      />
    )
  }

  if (section === 'agents') {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <PageHeading title={t('library.section.agents')} t={t} cwd={cwd} />
        {notice && <Notice text={notice} />}
        {targets.isLoading && <p className="text-sm text-fg-secondary">{t('library.loading')}</p>}
        {targets.error && <p className="text-sm text-danger">{errorText(targets.error, t)}</p>}
        <div className="space-y-3">
          {(targets.data ?? []).map((target) => (
            <AgentCard key={target.actor} target={target} t={t} onOpenLauncherSettings={onOpenLauncherSettings} />
          ))}
        </div>
      </div>
    )
  }

  const data = page.data
  const found = (data?.found ?? []).filter((item) => filter === 'all' || item.actor === filter)
  const managed = (data?.library.items ?? []).filter((item) => {
    if (item.kind !== kind) return false
    if (filter === 'all') return true
    if (item.originActor === filter) return true
    return data?.library.bindings.some((binding) => binding.libraryItemId === item.id && binding.actor === filter) ?? false
  })

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-base font-medium text-fg">
            {section === 'mcp' ? t('library.mcp.path') : t('library.skills.path')}
          </h1>
          <PageHeading title="" t={t} cwd={cwd} rejected={data?.cwdRejected} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <IconTextButton icon={<Search size={14} strokeWidth={2} />} label={t('library.action.discover')} onClick={() => document.getElementById('library-discover')?.scrollIntoView({ block: 'start' })} />
          <IconTextButton icon={<FolderOpen size={14} strokeWidth={2} />} label={t('library.action.folder')} onClick={() => void openLibrary('dir')} />
          <IconTextButton icon={<Archive size={14} strokeWidth={2} />} label={t('library.action.backups')} onClick={() => void openLibrary('backup')} />
          <IconTextButton icon={<RefreshCw size={14} strokeWidth={2} />} label={t('library.action.refresh')} onClick={refresh} />
        </div>
      </div>

      {notice && <Notice text={notice} />}
      <p className="text-xs text-fg-secondary mb-3">{t('library.writesDisabled')} {t('library.completeness.filesystem_partial')}</p>
      {located.length > 0 && (
        <div className="space-y-2 mb-4">
          {located.map((item) => (
            <article key={item.id} className="rounded-lg border border-border px-3 py-2">
              <div className="text-sm text-fg">{item.name}</div>
              <p className="text-xs text-fg-secondary mt-1 break-all">{item.path}</p>
              {item.readOnly && <p className="text-xs text-fg-secondary mt-1">{t('library.ownership.plugin')}</p>}
              <div className="mt-2">
                <TextButton
                  label={t('library.found.import')}
                  disabled={item.readOnly}
                  title={item.readOnly ? t('library.ownership.plugin') : undefined}
                  onClick={() => plan.mutate({ action: 'import', kind: 'skill', source: item.path })}
                />
              </div>
            </article>
          ))}
        </div>
      )}

      <form
        className="flex gap-2 mb-4"
        onSubmit={(event) => {
          event.preventDefault()
          plan.mutate({ action: 'find', kind, source })
        }}
      >
        <input
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder={t('library.find.placeholder')}
          className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg"
        />
        <button type="submit" className="px-3 py-2 text-sm rounded-lg bg-bg-subtle text-fg">
          {t('library.find.submit')}
        </button>
      </form>

      {page.isLoading && <p className="text-sm text-fg-secondary">{t('library.loading')}</p>}
      {page.error && <p className="text-sm text-danger mb-3">{errorText(page.error, t)}</p>}

      {data && (
        <>
          <div className="flex gap-2 overflow-x-auto pb-2 mb-3">
            <FilterButton active={filter === 'all'} label={t('library.agent.all')} onClick={() => setFilter('all')} />
            {data.targets.map((target) => (
              <FilterButton
                key={target.actor}
                active={filter === target.actor}
                label={`${actorName(target.actor, t)} · ${t(STATUS_KEY[target.status])}`}
                danger={target.status === 'read_failed' || target.status === 'partial'}
                onClick={() => setFilter(target.actor)}
              />
            ))}
          </div>
          <ProblemList targets={data.targets} t={t} />

          <LibraryResourceList key={kind} kind={kind} items={managed} page={data} busy={plan.isPending}
            onAction={(action) => plan.mutateAsync(action)} t={t} />

          <section className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-sm font-medium text-fg">{t('library.found.title')}</h2>
              <TextButton label={t('library.found.select')} onClick={() => setSelecting((value) => !value)} />
              <TextButton
                label={t('library.found.importAll')}
                onClick={() => {
                  const importable = found.filter(isImportableFoundInstance)
                  const ids = Object.entries(selected)
                    .filter(([id, on]) => on && importable.some((item) => item.id === id))
                    .map(([id]) => id)
                  if (selecting) {
                    if (ids.length === 0) return
                    plan.mutate({ action: 'import', kind, instanceIds: ids })
                    return
                  }
                  plan.mutate({ action: 'import_all', kind })
                }}
              />
            </div>
            {found.length === 0 && <p className="text-sm text-fg-secondary">{t('library.found.none')}</p>}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {found.map((item) => {
                const importable = isImportableFoundInstance(item)
                return (
                  <article key={item.id} className="min-w-0 rounded-lg border border-border px-3 py-3 flex flex-col gap-2">
                    <div className="flex items-start gap-2">
                      {selecting && (
                        <input
                          type="checkbox"
                          checked={Boolean(selected[item.id])}
                          disabled={!importable}
                          title={!importable ? t('library.ownership.plugin') : undefined}
                          onChange={() => {
                            if (!importable) return
                            setSelected((current) => ({ ...current, [item.id]: !current[item.id] }))
                          }}
                          aria-label={item.name}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-fg break-words">{item.name}</div>
                        {item.description && <p className="text-xs text-fg-secondary mt-1 break-words">{item.description}</p>}
                        <p className="text-xs text-fg-secondary mt-1 break-all">
                          {actorName(item.actor, t)} · {t(item.scope === 'project' ? 'library.scope.project' : item.scope === 'plugin' ? 'library.scope.plugin' : item.scope === 'shared' ? 'library.scope.shared' : 'library.scope.user')} · {item.path}
                        </p>
                        {item.linkSource && <p className="text-xs text-fg-secondary break-all">{t('library.linkedFrom', { path: item.linkSource })}</p>}
                        {item.sharedWith.length > 0 && (
                          <p className="text-xs text-fg-secondary">{t('library.sharedWith', { actors: item.sharedWith.map((actor) => actorName(actor, t)).join(', ') })}</p>
                        )}
                        {!importable && <p className="text-xs text-fg-secondary">{t('library.ownership.plugin')}</p>}
                      </div>
                    </div>
                    <div className="mt-auto">
                      <TextButton
                        label={t('library.found.import')}
                        disabled={!importable}
                        title={!importable ? t('library.ownership.plugin') : undefined}
                        onClick={() => {
                          if (!importable) return
                          plan.mutate({ action: 'import', kind, instanceId: item.id })
                        }}
                      />
                    </div>
                  </article>
                )
              })}
            </div>
          </section>

          <section id="library-discover">
            <h2 className="text-sm font-medium text-fg mb-2">{t('library.market.title')}</h2>
            <p className="text-sm text-fg-secondary mb-3">{t(kind === 'mcp' ? 'library.market.offlineMcp' : 'library.market.offline')}</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(kind === 'mcp' ? FEATURED_MCPS : FEATURED_SKILLS).map((card) => {
                const already = (data?.library.items ?? []).some((item) => item.kind === kind && item.repository === catalogRepositoryKey(card.id))
                return (
                  <article key={card.id} className="rounded-lg border border-border px-3 py-3 flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-medium text-fg">{card.name}</h3>
                      <span className="shrink-0 text-[11px] text-fg-secondary">{t('library.market.source', { source: card.source })}</span>
                    </div>
                    <p className="text-xs text-fg-secondary flex-1">{card.description}</p>
                    <div>
                      <TextButton
                        label={already ? t('library.market.added') : t('library.market.add')}
                        disabled={already || plan.isPending}
                        onClick={() => {
                          if (already) return
                          plan.mutate({ action: 'save', kind, source: catalogRepositoryKey(card.id) })
                        }}
                      />
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

const ASSIGN_STATUS: Record<Exclude<AssignBlock, 'none'> | 'unknown', TranslationKey> = {
  unsupported: 'library.status.unsupported',
  unrecognized: 'library.status.unrecognized',
  uninitialized: 'library.status.uninitialized',
  read_failed: 'library.status.read_failed',
  unknown: 'library.status.unsupported'
}

function assignmentRows(
  targets: TargetScan[],
  bindings: { libraryItemId: string; actor: string }[],
  itemId: string
): Array<{ actor: string; block: AssignBlock | 'unknown' }> {
  const rows: Array<{ actor: string; block: AssignBlock | 'unknown' }> = targets.map((target) => ({ actor: target.actor, block: target.assignBlock }))
  for (const binding of bindings) {
    if (binding.libraryItemId === itemId && !rows.some((row) => row.actor === binding.actor)) {
      rows.push({ actor: binding.actor, block: 'unknown' })
    }
  }
  return rows
}

function AgentCard({ target, t, onOpenLauncherSettings }: { target: ResolvedTarget; t: TFunction; onOpenLauncherSettings: () => void }) {
  const resolutionKey: TranslationKey = target.resolution === 'ready'
    ? 'library.resolution.ready'
    : target.resolution === 'unsupported'
      ? 'library.resolution.unsupported'
      : 'library.resolution.unrecognized'
  return (
    <article className="rounded-lg border border-border px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-fg">{actorName(target.actor, t)}</h2>
        <span className="text-xs text-fg-secondary">{t(resolutionKey)}</span>
      </div>
      <p className="text-xs text-fg-secondary mt-1">{t('library.protocol')}: {target.protocol}</p>
      <p className="text-xs text-fg-secondary break-all">{t('library.command')}: {target.command} {target.args.join(' ')}</p>
      <p className="text-xs text-fg-secondary">{t('library.adapter')}: {target.adapter}</p>
      <p className="text-xs text-fg-secondary">{t('library.version.notProbed')}</p>
      <p className="text-xs text-fg-secondary">{t('library.writesDisabled')}</p>
      <button
        type="button"
        onClick={onOpenLauncherSettings}
        className="mt-2 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg text-fg-secondary hover:text-fg hover:bg-bg-subtle"
      >
        <Settings size={14} strokeWidth={2} />
        {t('library.openLauncher')}
      </button>
      {target.notes.map((note) => <p key={note} className="text-xs text-fg-secondary mt-1">{t(NOTE_KEY[note])}</p>)}
      {target.locations.length > 0 && (
        <ul className="mt-2 space-y-1">
          {target.locations.map((location) => (
            <li key={location.id} className="text-xs text-fg-secondary break-all">
              {t('library.config')}: {location.path}
              {' · '}
              {location.error ? problemText({ code: location.error, path: location.path }, t) : location.exists ? t('library.location.present') : t('library.location.missing')}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function ProblemList({ targets, t }: { targets: TargetScan[]; t: TFunction }) {
  const problems = useMemo(() => targets.flatMap((target) => target.problems.map((problem) => ({ actor: target.actor, problem }))), [targets])
  if (problems.length === 0) return null
  return (
    <ul className="mb-4 space-y-1">
      {problems.map((entry, index) => (
        <li key={`${entry.actor}-${entry.problem.path}-${index}`} className="text-xs text-danger break-all">
          {actorName(entry.actor, t)} · {problemText(entry.problem, t)}
        </li>
      ))}
    </ul>
  )
}

function problemText(problem: ScanProblem, t: TFunction): string {
  const key = PROBLEM_KEY[problem.code] ?? 'library.problem.unknown'
  return t(key, { path: problem.path })
}

function PageHeading({ title, t, cwd, rejected }: { title: string; t: TFunction; cwd?: string; rejected?: boolean }) {
  return (
    <div className="mb-3">
      {title && <h1 className="text-base font-medium text-fg">{title}</h1>}
      <p className="text-xs text-fg-secondary">
        {rejected ? t('library.workspace.rejected') : cwd ? t('library.workspace.current', { path: cwd }) : t('library.workspace.none')}
      </p>
    </div>
  )
}

type ManagedKind = 'instruction' | 'subagent' | 'hook'

interface ManagedDraft {
  id: string | null
  name: string
  description: string
  content: string
  event: string
  matcher: string
  command: string
  timeoutSeconds: string
}

function ManagedLibraryPanel({
  kind,
  cwd,
  taskId,
  workspaceKey,
  notice,
  setNotice,
  plan,
  refresh,
  openLibrary,
  t
}: {
  kind: ManagedKind
  cwd?: string
  taskId?: string | null
  workspaceKey?: string | null
  notice: string | null
  setNotice: (value: string | null) => void
  plan: { mutate: (action: ExtensionActionRequest) => void; mutateAsync: (action: ExtensionActionRequest) => Promise<ExtensionActionResult>; isPending: boolean }
  refresh: () => void
  openLibrary: (which: 'dir' | 'backup') => Promise<void>
  t: TFunction
}) {
  const targets = useExtensionTargets({
    cwd: cwd || undefined,
    taskId: taskId || undefined,
    workspaceKey: workspaceKey || undefined
  })
  const library = useExtensionLibrary(true)
  const [editing, setEditing] = useState<ManagedDraft | null>(null)
  const items = (library.data?.items ?? []).filter((item) => item.kind === kind)
  const bindings = library.data?.bindings ?? []
  const pathKey: TranslationKey = kind === 'instruction'
    ? 'library.instructions.path'
    : kind === 'subagent'
      ? 'library.subagents.path'
      : 'library.hooks.path'
  const hintKey: TranslationKey = kind === 'instruction'
    ? 'library.instructions.hint'
    : kind === 'subagent'
      ? 'library.subagents.hint'
      : 'library.hooks.hint'
  const emptyKey: TranslationKey = kind === 'instruction'
    ? 'library.instructions.empty'
    : kind === 'subagent'
      ? 'library.subagents.empty'
      : 'library.hooks.empty'
  const newKey: TranslationKey = kind === 'instruction'
    ? 'library.instructions.new'
    : kind === 'subagent'
      ? 'library.subagents.new'
      : 'library.hooks.new'

  const blankDraft = (): ManagedDraft => ({
    id: null,
    name: '',
    description: '',
    content: '',
    event: 'turn-end',
    matcher: '',
    command: '',
    timeoutSeconds: ''
  })

  const openEditor = async (item: LibraryItem | null) => {
    if (!item) {
      setEditing(blankDraft())
      return
    }
    try {
      const result = await plan.mutateAsync({ action: 'read', kind, libraryItemId: item.id })
      if (kind === 'hook') {
        const parsed = safeJson(result.content ?? '')
        setEditing({
          id: item.id,
          name: String(parsed?.name ?? result.name ?? item.name),
          description: String(parsed?.description ?? ''),
          content: '',
          event: String(parsed?.event ?? 'turn-end'),
          matcher: String(parsed?.matcher ?? ''),
          command: String(parsed?.command ?? ''),
          timeoutSeconds: parsed?.timeoutSeconds != null ? String(parsed.timeoutSeconds) : ''
        })
        return
      }
      if (kind === 'subagent') {
        const parsed = parseSubagentFrontmatter(result.content ?? '')
        setEditing({
          id: item.id,
          name: parsed.name || (result.name ?? item.name),
          description: parsed.description,
          content: parsed.prompt,
          event: 'turn-end',
          matcher: '',
          command: '',
          timeoutSeconds: ''
        })
        return
      }
      setEditing({
        ...blankDraft(),
        id: item.id,
        name: result.name ?? item.name,
        content: result.content ?? ''
      })
    } catch {
      setNotice(t('library.error.generic'))
    }
  }

  const saveDraft = (draft: ManagedDraft) => {
    if (kind === 'hook') {
      plan.mutate({
        action: 'save',
        kind: 'hook',
        libraryItemId: draft.id ?? undefined,
        name: draft.name,
        description: draft.description,
        event: draft.event,
        matcher: draft.matcher || undefined,
        command: draft.command,
        timeoutSeconds: draft.timeoutSeconds ? Number(draft.timeoutSeconds) : 0
      })
    } else if (kind === 'subagent') {
      plan.mutate({
        action: 'save',
        kind: 'subagent',
        libraryItemId: draft.id ?? undefined,
        name: draft.name,
        description: draft.description,
        content: draft.content
      })
    } else {
      plan.mutate({
        action: 'save',
        kind: 'instruction',
        libraryItemId: draft.id ?? undefined,
        name: draft.name,
        content: draft.content
      })
    }
    setEditing(null)
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-base font-medium text-fg">{t(pathKey)}</h1>
          <PageHeading title="" t={t} cwd={cwd} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <IconTextButton icon={<FolderOpen size={14} strokeWidth={2} />} label={t('library.action.folder')} onClick={() => void openLibrary('dir')} />
          <IconTextButton icon={<Archive size={14} strokeWidth={2} />} label={t('library.action.backups')} onClick={() => void openLibrary('backup')} />
          <IconTextButton icon={<RefreshCw size={14} strokeWidth={2} />} label={t('library.action.refresh')} onClick={refresh} />
        </div>
      </div>
      {notice && <Notice text={notice} />}
      <p className="text-xs text-fg-secondary mb-3">{t(hintKey)}</p>
      <div className="mb-4">
        <TextButton label={t(newKey)} onClick={() => void openEditor(null)} />
      </div>
      {editing && (
        <div className="mb-6 rounded-lg border border-border px-3 py-3 space-y-2">
          <input
            value={editing.name}
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            placeholder={t(kind === 'subagent' ? 'library.subagents.name' : kind === 'hook' ? 'library.hooks.name' : 'library.instructions.name')}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg"
          />
          {(kind === 'subagent' || kind === 'hook') && (
            <input
              value={editing.description}
              onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              placeholder={t('library.field.description')}
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg"
            />
          )}
          {kind === 'hook' ? (
            <>
              <select
                value={editing.event}
                onChange={(event) => setEditing({ ...editing, event: event.target.value })}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg"
              >
                <option value="turn-end">turn-end</option>
                <option value="after-tool">after-tool</option>
                <option value="before-tool">before-tool</option>
                <option value="prompt">prompt</option>
                <option value="session-start">session-start</option>
              </select>
              <input
                value={editing.matcher}
                onChange={(event) => setEditing({ ...editing, matcher: event.target.value })}
                placeholder={t('library.hooks.matcher')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg"
              />
              <input
                value={editing.command}
                onChange={(event) => setEditing({ ...editing, command: event.target.value })}
                placeholder={t('library.hooks.command')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg font-mono"
              />
              <input
                value={editing.timeoutSeconds}
                onChange={(event) => setEditing({ ...editing, timeoutSeconds: event.target.value })}
                placeholder={t('library.hooks.timeout')}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg"
              />
            </>
          ) : (
            <textarea
              value={editing.content}
              onChange={(event) => setEditing({ ...editing, content: event.target.value })}
              placeholder={t(kind === 'subagent' ? 'library.subagents.prompt' : 'library.instructions.content')}
              rows={10}
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-bg text-fg font-mono"
            />
          )}
          <div className="flex gap-2">
            <TextButton
              label={t('library.instructions.save')}
              disabled={plan.isPending || !editing.name.trim() || (kind === 'hook' && !editing.command.trim())}
              onClick={() => saveDraft(editing)}
            />
            <TextButton label={t('library.instructions.cancel')} onClick={() => setEditing(null)} />
          </div>
        </div>
      )}
      {targets.isLoading || library.isLoading ? <p className="text-sm text-fg-secondary">{t('library.loading')}</p> : null}
      {library.data?.status === 'read_failed' && <p className="text-sm text-danger mb-2">{t('library.libraryStatus.read_failed')}</p>}
      {items.length === 0 && !editing && <p className="text-sm text-fg-secondary">{t(emptyKey)}</p>}
      <div className="space-y-2">
        {items.map((item) => (
          <article key={item.id} className="rounded-lg border border-border px-3 py-2">
            <div className="text-sm text-fg">{item.name}</div>
            {item.description && <p className="text-xs text-fg-secondary mt-1 whitespace-pre-wrap">{item.description}</p>}
            <div className="mt-2 flex gap-1">
              <TextButton label={t('library.instructions.edit')} onClick={() => void openEditor(item)} />
              <TextButton label={t('library.managed.remove')} onClick={() => plan.mutate({ action: 'remove', kind, libraryItemId: item.id })} />
            </div>
            <div className="flex gap-1 overflow-x-auto mt-2">
              {managedAssignmentRows(targets.data ?? [], bindings, item.id, kind).map((row) => {
                const binding = bindings.find((entry) => entry.libraryItemId === item.id && entry.actor === row.actor)
                const blocked = row.block !== 'none' && binding?.desired !== 'on'
                const blockKey = row.block === 'none' || row.block === 'unknown' ? 'unsupported' : row.block
                const status = blocked ? t(ASSIGN_STATUS[blockKey]) : ''
                return (
                  <FilterButton
                    key={row.actor}
                    active={binding?.desired === 'on'}
                    disabled={blocked}
                    title={blocked ? t('library.assign.blocked', { actor: actorName(row.actor, t), status }) : actorName(row.actor, t)}
                    label={blocked ? `${actorName(row.actor, t)} · ${status}` : actorName(row.actor, t)}
                    onClick={() => plan.mutate({
                      action: 'assign',
                      kind,
                      libraryItemId: item.id,
                      actor: row.actor,
                      desired: binding?.desired === 'on' ? 'off' : 'on'
                    })}
                  />
                )
              })}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

function managedAssignBlock(target: ResolvedTarget, kind: ManagedKind): AssignBlock {
  if (target.resolution === 'unrecognized') return 'unrecognized'
  if (target.resolution === 'unsupported' || target.discovery !== 'filesystem') return 'unsupported'
  if (!target.writesNativeConfig) return 'unsupported'
  const locationKind = kind === 'instruction' ? 'instructions' : kind === 'subagent' ? 'subagents' : 'hooks'
  const location = target.locations.find((item) => item.kind === locationKind && item.scope === 'user')
  if (!location) return 'unsupported'
  if (location.missingMeans === 'uninitialized' || location.note === 'acp_private_uninitialized') return 'uninitialized'
  if (location.error || location.missingMeans === 'read_failed') return 'read_failed'
  return 'none'
}

function managedAssignmentRows(
  targets: ResolvedTarget[],
  bindings: TargetBinding[],
  itemId: string,
  kind: ManagedKind
): Array<{ actor: string; block: AssignBlock | 'unknown' }> {
  const rows: Array<{ actor: string; block: AssignBlock | 'unknown' }> = targets.map((target) => ({
    actor: target.actor,
    block: managedAssignBlock(target, kind)
  }))
  for (const binding of bindings) {
    if (binding.libraryItemId === itemId && !rows.some((row) => row.actor === binding.actor)) {
      rows.push({ actor: binding.actor, block: 'unknown' })
    }
  }
  return rows
}

function parseSubagentFrontmatter(text: string): { name: string; description: string; prompt: string } {
  const match = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { name: '', description: '', prompt: text }
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '')
  }
  return { name: fields.name ?? '', description: fields.description ?? '', prompt: match[2].replace(/^\n+/, '').replace(/\n+$/, '') }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function Notice({ text }: { text: string }) {
  return <p className="text-sm text-fg mb-3 rounded-lg border border-border px-3 py-2">{text}</p>
}

function IconTextButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={label} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg text-fg-secondary hover:text-fg hover:bg-bg-subtle">
      {icon}
      {label}
    </button>
  )
}

function TextButton({ label, onClick, disabled, title, icon }: { label: string; onClick: () => void; disabled?: boolean; title?: string; icon?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg text-fg-secondary hover:text-fg hover:bg-bg-subtle ${disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''}`}>
      {icon}
      {label}
    </button>
  )
}

function FilterButton({ label, active, danger, disabled, title, onClick }: { label: string; active: boolean; danger?: boolean; disabled?: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`shrink-0 px-2 py-1 text-xs rounded-lg border ${active ? 'border-border bg-bg-subtle text-fg' : 'border-transparent text-fg-secondary hover:bg-bg-subtle'} ${danger ? 'text-danger' : ''} ${disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''}`}
    >
      {label}
    </button>
  )
}

function actionNotice(result: ExtensionActionResult, t: TFunction, action?: ExtensionActionRequest['action']): string {
  if ((action === 'sync' || action === 'skill_mode') && result.code === 'ok') {
    const failures = result.results.filter(r => r.status === 'failed')
    return [t('library.list.batchResult', { changed: result.results.filter(r => r.status === 'changed').length, failed: failures.length }), ...failures.map(r => t(`library.result.${r.code}` as TranslationKey, { actor: actorName(r.actor, t) }))].join(' ')
  }
  if (result.code === 'unknown_action') return t('library.blocked.unknown')
  if (result.tools) return t('library.probe.tools', { tools: result.tools.join(', ') || t('library.probe.empty') })
  if (result.found && result.found.length > 0) return result.found.map((item) => t('library.find.hit', { name: item.name })).join(' ')
  if (result.code === 'find_not_ready') return t('library.find.notReady')
  if (result.code === 'library_unreadable') return t('library.libraryStatus.read_failed')
  if (result.code === 'missing_target' || result.results.length === 0) return t('library.blocked')
  return result.results.map((entry) => {
    const key = `library.result.${entry.code}` as TranslationKey
    return t(key, { actor: actorName(entry.actor, t) || entry.actor })
  }).join(' ')
}

function actorName(actor: string, t: TFunction): string {
  const key = ACTOR_LABEL_KEY[actor]
  return key ? t(key) : actor
}

function errorText(error: unknown, t: TFunction): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'task_unreadable') return t('library.error.task')
  if (message === 'invalid_query') return t('library.error.query')
  return t('library.error.generic')
}
