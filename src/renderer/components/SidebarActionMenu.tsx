import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface SidebarMenuAnchor {
  x: number
  y: number
  align: 'left' | 'right'
}

export interface SidebarActionMenuProps {
  anchor: SidebarMenuAnchor
  onClose: () => void
  children: ReactNode
  minWidth?: number
}

const VIEWPORT_PADDING = 8

export function SidebarActionMenu({ anchor, onClose, children, minWidth = 168 }: SidebarActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Measure the rendered menu and clamp it into the viewport.
  useLayoutEffect(() => {
    const node = menuRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const menuWidth = rect.width || minWidth
    const menuHeight = rect.height || 0
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    const initialLeft = anchor.align === 'right' ? anchor.x - menuWidth : anchor.x
    const clampedLeft = Math.max(
      VIEWPORT_PADDING,
      Math.min(initialLeft, viewportWidth - menuWidth - VIEWPORT_PADDING)
    )

    const bottomOverflow = anchor.y + menuHeight + VIEWPORT_PADDING > viewportHeight
    const initialTop = bottomOverflow && anchor.y - menuHeight >= VIEWPORT_PADDING
      ? anchor.y - menuHeight
      : anchor.y
    const clampedTop = Math.max(
      VIEWPORT_PADDING,
      Math.min(initialTop, viewportHeight - menuHeight - VIEWPORT_PADDING)
    )

    setPosition({ left: clampedLeft, top: clampedTop })
  }, [anchor.x, anchor.y, anchor.align, minWidth])

  // Close on Escape.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Close on outside click.
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [onClose])

  // Close on window blur, scroll, and resize.
  useEffect(() => {
    const handleClose = () => onClose()
    window.addEventListener('blur', handleClose)
    window.addEventListener('resize', handleClose)
    window.addEventListener('scroll', handleClose, true)
    return () => {
      window.removeEventListener('blur', handleClose)
      window.removeEventListener('resize', handleClose)
      window.removeEventListener('scroll', handleClose, true)
    }
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed',
    minWidth,
    // Above the sidebar and any modals that might open from menu actions.
    zIndex: 60
  }
  if (position) {
    style.left = position.left
    style.top = position.top
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={style}
      className="bg-bg border border-fg-muted/40 rounded-lg shadow-lg py-0.5 text-[13px]"
    >
      {children}
    </div>,
    document.body
  )
}

export function SidebarMenuItem({
  icon,
  children,
  onSelect,
  danger,
  disabled
}: {
  icon?: ReactNode
  children: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        if (disabled) return
        onSelect()
      }}
      className={`w-full flex items-center gap-2 px-3 py-[3px] rounded-[4px] mx-0.5 ${
        danger ? 'text-danger' : 'text-fg'
      } ${disabled ? 'opacity-50 cursor-default' : 'hover:bg-bg-muted'}`}
    >
      {icon}
      {children}
    </button>
  )
}

export function SidebarMenuDivider() {
  return <div className="my-0.5 border-t border-border-subtle" />
}
