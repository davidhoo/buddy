import { useEffect, useRef } from 'react'
import { useT } from '../hooks/useI18n'

interface ConfirmDialogProps {
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, message, onConfirm, onCancel }: ConfirmDialogProps) {
  const t = useT()
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  // 自动聚焦确定按钮
  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]"
      data-buddy-modal
      onClick={onCancel}
    >
      <div
        className="bg-bg-elevated rounded-xl shadow-xl w-[360px] max-w-[90vw] p-5 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <h3 className="text-sm font-semibold mb-3">{title}</h3>
        <div className="text-sm leading-relaxed whitespace-pre-wrap">
          {message}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-fg hover:bg-bg-subtle rounded-lg transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            onClick={() => { onConfirm(); onCancel() }}
            className="px-3 py-1.5 text-sm bg-danger text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
