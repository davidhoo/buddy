import { useCallback, useRef, useEffect } from 'react'

interface ResizeHandleProps {
  onResize: (delta: number) => void
  direction: 'left' | 'right'
  className?: string
}

export function ResizeHandle({ onResize, direction, className = '' }: ResizeHandleProps) {
  const isDragging = useRef(false)
  const startX = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    startX.current = e.clientX
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = e.clientX - startX.current
      startX.current = e.clientX
      onResize(direction === 'left' ? -delta : delta)
    }

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      // 组件卸载时（如 sidebar 拖到阈值后被自动隐藏），如果还处于拖拽中，
      // mouseup 不会再触发到我们的 handler，需要主动清理 body 全局样式
      if (isDragging.current) {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [direction, onResize])

  return (
    <div
      className={`w-1 cursor-col-resize ${className}`}
      onMouseDown={handleMouseDown}
    />
  )
}
