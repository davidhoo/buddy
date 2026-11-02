import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowUp, ChevronDown, Square, X, Image as ImageIcon } from 'lucide-react'
import { AcpModelInfo, Attachment, TaskSettings, TaskState } from '../../shared/types'
import { taskActors, actorOptionLabel, modelOptionLabel, Actor } from '../lib/format'
import { useT, useSendShortcut } from '../hooks/useI18n'
import { IMAGE_EXTS, EXT_ICON_MAP, generateAttachmentId, isImageAttachment, fileExt, fileIconForName, mimeTypeForExt } from '../lib/attachments'

interface ComposerProps {
  onSend: (message: string, actor?: string, attachments?: Attachment[]) => void
  onStart: (actor?: string) => void
  onInterrupt: () => void
  onEnqueueInstruction: (content: string, attachments?: Attachment[]) => void
  isRunning: boolean
  isReady: boolean
  settings: TaskSettings | null
  taskState: TaskState | null
  taskId?: string
  workspaceKey?: string
  draft: string
  onDraftChange: (value: string) => void
  attachments: Attachment[]
  onAttachmentsChange: (attachments: Attachment[]) => void
}

/** Keep the task launcher model as-is. Never invent models[0]/currentModelId. */
function pickModelId(saved?: string): string {
  return saved?.trim() || ''
}

function modelCatalogKey(actor: string, protocol: string): string {
  return `${actor}:${protocol}`
}

export function Composer({ onSend, onStart, onInterrupt, onEnqueueInstruction, isRunning, isReady, settings, taskState, taskId, workspaceKey, draft, onDraftChange, attachments, onAttachmentsChange }: ComposerProps) {
  const t = useT()
  const { shortcut } = useSendShortcut()
  const { impl, participants } = taskActors(settings)
  const [nextActor, setNextActor] = useState<Actor>(impl)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevStateNextRef = useRef<string | undefined>()
  const selectedModelByActorRef = useRef<Record<string, string>>({})
  // Cross-actor stale-while-revalidate: switching handoff must not flash loading
  // when this actor was already probed in the current composer session.
  const modelCatalogByActorRef = useRef<Map<string, AcpModelInfo[]>>(new Map())
  const persistChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const nextProtocol = settings?.launchers?.[nextActor]?.protocol === 'acp' ? 'acp' : 'cli'
  const [modelState, setModelState] = useState<{
    status: 'idle' | 'loading' | 'ready'
    actor: string
    protocol: 'cli' | 'acp' | ''
    models: AcpModelInfo[]
    selected: string
  }>({ status: 'loading', actor: '', protocol: '', models: [], selected: '' })

  const computedNext = (() => {
    if (isRunning && taskState?.active_run?.actor) {
      return participants.find(a => a !== taskState.active_run!.actor) || impl
    }
    return taskState?.next_actor || impl
  })()

  useEffect(() => {
    if (computedNext && computedNext !== prevStateNextRef.current) {
      prevStateNextRef.current = computedNext
      if (participants.includes(computedNext as Actor)) {
        setNextActor(computedNext as Actor)
      }
    }
  }, [computedNext, participants])

  const persistModel = useCallback((actor: string, model: string) => {
    // Empty string clears launcher.model (agent default). Do not treat it as a no-op.
    if (!taskId || !workspaceKey || !window.buddy?.updateTaskLauncherModel) return
    persistChainRef.current = persistChainRef.current
      .then(() => window.buddy.updateTaskLauncherModel(taskId, workspaceKey, actor, model))
      .then(() => undefined)
      .catch(() => undefined)
  }, [taskId, workspaceKey])

  useEffect(() => {
    let cancelled = false
    const remembered = Object.prototype.hasOwnProperty.call(selectedModelByActorRef.current, nextActor)
    const saved = remembered
      ? selectedModelByActorRef.current[nextActor]
      : (settings?.launchers?.[nextActor]?.model || '')
    const catalogKey = modelCatalogKey(nextActor, nextProtocol)
    const cached = modelCatalogByActorRef.current.get(catalogKey)
    const hasCache = cached !== undefined
    // Stale-while-revalidate across actors: show the last good catalog immediately.
    setModelState({
      status: hasCache ? 'ready' : 'loading',
      actor: nextActor,
      protocol: nextProtocol,
      models: cached ?? [],
      selected: pickModelId(saved)
    })
    const cwd = taskState?.repo_root?.trim() || undefined
    const taskLauncher = settings?.launchers?.[nextActor]
    const modelContext = {
      launcher: taskLauncher,
      ...(taskId && workspaceKey ? { taskId, workspaceKey } : {})
    }
    const pending = nextProtocol === 'acp'
      ? window.buddy?.listAcpModels?.(nextActor, cwd, modelContext)
      : window.buddy?.listCliModels?.(nextActor, modelContext)
    if (!pending) {
      if (!hasCache) {
        setModelState({
          status: 'ready',
          actor: nextActor,
          protocol: nextProtocol,
          models: [],
          selected: pickModelId(saved)
        })
      }
      return
    }
    pending
      .then(list => {
        if (cancelled) return
        const models = list?.models ?? []
        const stale = modelCatalogByActorRef.current.get(catalogKey)
        // Failed probes keep the last good catalog; a successful empty list
        // is a real state and must replace it.
        if (list?.error && models.length === 0 && stale && stale.length > 0) {
          setModelState({
            status: 'ready',
            actor: nextActor,
            protocol: nextProtocol,
            models: stale,
            selected: pickModelId(saved)
          })
          return
        }
        modelCatalogByActorRef.current.set(catalogKey, models)
        setModelState({
          status: 'ready',
          actor: nextActor,
          protocol: nextProtocol,
          models,
          selected: pickModelId(saved)
        })
      })
      .catch(() => {
        if (cancelled) return
        const stale = modelCatalogByActorRef.current.get(catalogKey)
        setModelState({
          status: 'ready',
          actor: nextActor,
          protocol: nextProtocol,
          models: stale ?? [],
          selected: pickModelId(saved)
        })
      })
    const unsub = window.buddy?.onModelCatalog?.(update => {
      if (cancelled) return
      if (update.actor !== nextActor || update.protocol !== nextProtocol) return
      const models = update.list?.models ?? []
      if (update.list?.error && models.length === 0) {
        const stale = modelCatalogByActorRef.current.get(catalogKey)
        if (stale && stale.length > 0) {
          setModelState({
            status: 'ready',
            actor: nextActor,
            protocol: nextProtocol,
            models: stale,
            selected: pickModelId(saved)
          })
          return
        }
      }
      modelCatalogByActorRef.current.set(catalogKey, models)
      setModelState({
        status: 'ready',
        actor: nextActor,
        protocol: nextProtocol,
        models,
        selected: pickModelId(saved)
      })
    })
    return () => { cancelled = true; unsub?.() }
  }, [nextProtocol, nextActor, taskState?.repo_root, settings?.launchers, taskId, workspaceKey])

  const handleModelChange = (model: string) => {
    setModelState(prev => ({ ...prev, selected: model }))
    selectedModelByActorRef.current[nextActor] = model
    persistModel(nextActor, model)
  }

  const flushPersistedModel = () => persistChainRef.current

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [draft])

  const removeAttachment = useCallback((id: string) => {
    onAttachmentsChange(attachments.filter(a => {
      if (a.id === id) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
        return false
      }
      return true
    }))
  }, [attachments, onAttachmentsChange])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    if (!items || items.length === 0) return

    const newAttachments: Attachment[] = []

    // Check for images in clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue

        const previewUrl = URL.createObjectURL(file)
        const buffer = await file.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        for (let j = 0; j < bytes.length; j++) {
          binary += String.fromCharCode(bytes[j])
        }
        const bufferBase64 = btoa(binary)

        newAttachments.push({
          id: generateAttachmentId(),
          name: file.name || `paste-${Date.now()}.png`,
          category: 'image',
          mimeType: item.type,
          size: file.size,
          previewUrl,
          bufferBase64,
        })
      }
    }

    // If no images found, check for file paths via main process
    if (newAttachments.length === 0 && e.clipboardData.files.length > 0) {
      e.preventDefault()
      try {
        const fileEntries: Array<{ path: string; size: number }> = await window.api.readClipboardFilePaths()
        for (const entry of fileEntries) {
          // Skip duplicate file paths
          if (attachments.some(a => a.filePath === entry.path)) continue
          const name = entry.path.split('/').pop() ?? entry.path
          const mimeType = mimeTypeForExt(name)
          const isImage = mimeType.startsWith('image/')
          let previewUrl: string | undefined
          if (isImage) {
            try {
              previewUrl = await window.api.readFileAsDataURL(entry.path, mimeType)
            } catch {
              // Fall back to no preview
            }
          }
          newAttachments.push({
            id: generateAttachmentId(),
            name,
            category: isImage ? 'image' : 'file',
            mimeType,
            size: entry.size,
            filePath: entry.path,
            previewUrl,
          })
        }
      } catch {
        // Ignore clipboard read errors
      }
    }

    if (newAttachments.length > 0) {
      onAttachmentsChange([...attachments, ...newAttachments])
    }
  }, [attachments, onAttachmentsChange])

  const handleSend = () => {
    const hasContent = draft.trim() || attachments.length > 0
    if (!hasContent) return

    const actor = nextActor
    const message = draft.trim()
    const queued = isRunning
    const atts = attachments.length > 0 ? attachments : undefined
    // Cleanup preview URLs
    for (const att of attachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
    }
    onDraftChange('')
    onAttachmentsChange([])
    void flushPersistedModel().then(() => {
      if (queued) {
        onEnqueueInstruction(message, atts)
      } else {
        onSend(message, actor, atts)
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
    if (ne.isComposing || ne.keyCode === 229) return
    if (e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      if (draft.trim() || attachments.length > 0) {
        handleSend()
      } else if (isReady) {
        void flushPersistedModel().then(() => onStart(nextActor))
      }
      return
    }
    if (shortcut === 'cmd-enter') return
    const shouldSend = shortcut === 'enter' ? !e.shiftKey : e.shiftKey
    if (!shouldSend) return
    e.preventDefault()
    if (!draft.trim() && attachments.length === 0) return
    handleSend()
  }

  const hasDraft = draft.trim().length > 0 || attachments.length > 0
  const showStop = isRunning && !hasDraft
  const showEnqueue = isRunning && hasDraft
  const showStart = isReady && !hasDraft && !isRunning
  const handlePrimary = showStop
    ? onInterrupt
    : showStart
      ? () => { void flushPersistedModel().then(() => onStart(nextActor)) }
      : handleSend
  const primaryDisabled = showStop ? false : showStart ? false : !hasDraft

  const placeholder = isRunning
    ? t('composer.placeholder.running')
    : t('composer.placeholder.idle')
  const sendHint = isRunning && hasDraft
    ? t('composer.hint.enqueue')
    : shortcut === 'enter' ? t('composer.hint.enter') : shortcut === 'shift-enter' ? t('composer.hint.shiftEnter') : t('composer.hint.cmdEnter')

  const imageAttachments = attachments.filter(a => isImageAttachment(a))
  const fileAttachments = attachments.filter(a => !isImageAttachment(a))

  return (
    <div className="rounded-2xl border border-border bg-bg-elevated shadow-sm relative z-[1]">
      {attachments.length > 0 && (
        <div className="px-4 pt-3 space-y-2">
          {/* Image thumbnails row */}
          {imageAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {imageAttachments.map(att => (
                <div
                  key={att.id}
                  className="group relative rounded-lg overflow-hidden border border-border bg-bg-base"
                >
                  {att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-20 w-auto max-w-[160px] object-cover"
                    />
                  ) : (
                    <div className="h-20 w-20 flex items-center justify-center bg-bg-subtle">
                      <ImageIcon size={20} className="text-fg-muted" />
                    </div>
                  )}
                  <button
                    onClick={() => removeAttachment(att.id)}
                    className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger"
                    title={t('composer.attachment.remove')}
                  >
                    <X size={12} strokeWidth={2.5} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* File attachment cards */}
          {fileAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {fileAttachments.map(att => {
                const Icon = fileIconForName(att.name)
                const ext = fileExt(att.name)
                return (
                  <div
                    key={att.id}
                    className="group relative rounded-lg border border-border bg-bg-base px-2.5 py-1.5 flex items-center gap-2.5 max-w-[220px] hover:border-border-primary transition-colors"
                  >
                    <Icon size={28} className="flex-shrink-0 text-fg-muted" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-xs text-fg-secondary">{att.name}</div>
                      {ext && (
                        <div className="text-[10px] text-fg-muted">{ext}</div>
                      )}
                    </div>
                    <button
                      onClick={() => removeAttachment(att.id)}
                      className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger"
                      title={t('composer.attachment.remove')}
                    >
                      <X size={12} strokeWidth={2.5} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="px-4 pt-3 pb-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent border-0 outline-none text-sm leading-relaxed placeholder:text-fg-muted"
          rows={2}
        />

        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1 text-xs text-fg-muted select-none">
            {isRunning && !hasDraft ? (
              t('composer.hint.running')
            ) : (
              sendHint
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-secondary select-none">
              {t('composer.nextHandoff')}
            </span>

            <div className="relative">
              <select
                aria-label={t('composer.nextHandoff')}
                value={nextActor}
                onChange={(e) => setNextActor(e.target.value as Actor)}
                className="appearance-none bg-transparent text-sm font-medium pr-5 pl-1 py-1 outline-none cursor-pointer hover:text-accent"
              >
                {participants.map(a => (
                  <option key={a} value={a}>{actorOptionLabel(a, t)}</option>
                ))}
              </select>
              <ChevronDown
                size={10}
                strokeWidth={2}
                className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted"
              />
            </div>

            <div className="relative max-w-[160px]">
              <select
                aria-label={t('modal.create.model')}
                value={
                  modelState.status !== 'ready' && modelState.models.length === 0
                    ? ''
                    : modelState.models.length === 0
                      ? ''
                      : modelState.selected
                }
                disabled={modelState.status !== 'ready' || modelState.models.length === 0}
                aria-busy={modelState.status !== 'ready'}
                onChange={(e) => handleModelChange(e.target.value)}
                className="appearance-none bg-transparent text-xs pr-5 pl-1 py-1 outline-none cursor-pointer hover:text-accent disabled:opacity-60 disabled:cursor-not-allowed max-w-[160px] truncate"
              >
                {modelState.status !== 'ready' && modelState.models.length === 0 && (
                  <option value="">{t('common.loading')}</option>
                )}
                {(modelState.status === 'ready' || modelState.models.length > 0) && (
                  <option value="">{t('agents.native')}</option>
                )}
                {modelState.models.length > 0
                  && modelState.selected
                  && !modelState.models.some(model => model.id === modelState.selected) && (
                  <option value={modelState.selected}>
                    {modelOptionLabel(modelState.selected, modelState.models, { nativeLabel: t('agents.native') })}
                  </option>
                )}
                {modelState.models.map(model => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              <ChevronDown
                size={10}
                strokeWidth={2}
                className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted"
              />
            </div>

            <button
              onClick={handlePrimary}
              disabled={primaryDisabled}
              title={showStop ? t('composer.button.interrupt') : showEnqueue ? t('composer.button.enqueue') : showStart ? t('composer.button.start') : t('composer.button.send')}
              className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                showStop
                  ? 'bg-danger hover:bg-danger-hover text-fg-inverse'
                  : 'bg-accent-primary text-fg-inverse hover:bg-accent-primary-hover'
              }`}
            >
              {showStop ? (
                <Square size={14} fill="currentColor" stroke="none" />
              ) : (
                <ArrowUp size={16} strokeWidth={2.5} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
