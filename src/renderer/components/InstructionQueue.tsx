import { useState, useRef, useEffect } from 'react'
import { MoreHorizontal, Pencil, Eraser } from 'lucide-react'
import { InstructionQueueItem } from '../../shared/types'
import { useT } from '../hooks/useI18n'

export function QueueMenu({
  item,
  onEdit,
  onClearQueue
}: {
  item: InstructionQueueItem
  onEdit: (item: InstructionQueueItem) => void
  onClearQueue: () => void
}) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        title={t('sidebar.tooltipMore')}
        className="p-1 rounded hover:text-fg-primary text-fg-muted transition-colors cursor-pointer"
      >
        <MoreHorizontal size={12} />
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 bg-bg-elevated border border-border rounded-lg shadow-lg py-1 z-50 min-w-[120px]">
          <button
            onClick={() => { onEdit(item); setMenuOpen(false) }}
            className="w-full px-3 py-1.5 text-left text-xs hover:bg-bg-subtle flex items-center gap-2 cursor-pointer"
          >
            <Pencil size={12} />
            {t('queue.edit')}
          </button>
          <button
            onClick={() => { onClearQueue(); setMenuOpen(false) }}
            className="w-full px-3 py-1.5 text-left text-xs hover:bg-bg-subtle flex items-center gap-2 text-danger cursor-pointer"
          >
            <Eraser size={12} />
            {t('queue.clearQueue')}
          </button>
        </div>
      )}
    </div>
  )
}

interface InstructionQueueProps {
  items: InstructionQueueItem[]
  onInterruptAndInsert: (itemId: string) => void
  onRemove: (itemId: string) => void
  onEdit: (item: InstructionQueueItem) => void
  onClearQueue: () => void
}

export function InstructionQueue({ items, onInterruptAndInsert, onRemove, onEdit, onClearQueue }: InstructionQueueProps) {
  const t = useT()
  if (items.length === 0) return null

  return (
    <div className="px-8 pb-1 space-y-0.5">
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-elevated border border-border text-xs group">
          <span className="flex-1 truncate text-fg-secondary">{item.content}</span>
          <div className="flex items-center gap-1.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onInterruptAndInsert(item.id)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:text-accent text-fg-muted transition-colors cursor-pointer"
            >
              <span className="text-[11px]">{t('queue.interruptAndInsert')}</span>
            </button>
            <button
              onClick={() => onRemove(item.id)}
              title={t('common.delete')}
              className="p-1 rounded hover:text-danger text-fg-muted transition-colors cursor-pointer"
            >
              <span className="text-[11px]">✕</span>
            </button>
            <QueueMenu
              item={item}
              onEdit={onEdit}
              onClearQueue={onClearQueue}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
