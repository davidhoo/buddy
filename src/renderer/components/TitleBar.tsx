interface TitleBarProps {
  taskName: string
  isSidebarOpen: boolean
  isStatusBarOpen: boolean
  onToggleSidebar: () => void
  onToggleStatusBar: () => void
}

export function TitleBar({
  taskName,
  isSidebarOpen,
  isStatusBarOpen,
  onToggleSidebar,
  onToggleStatusBar
}: TitleBarProps) {
  return (
    <div className="h-13 flex items-center px-4 bg-house-green text-white drag-region">
      {/* 红绿灯占位 */}
      <div className="w-[68px] flex-shrink-0" />
      
      {/* 左侧栏切换按钮 */}
      <button
        onClick={onToggleSidebar}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 no-drag"
        title={isSidebarOpen ? '收起侧边栏' : '展开侧边栏'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </button>
      
      {/* 任务名 */}
      <div className="flex-1 text-center text-sm font-medium truncate px-4">
        {taskName || 'buddy'}
      </div>
      
      {/* 右侧栏切换按钮 */}
      <button
        onClick={onToggleStatusBar}
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 no-drag"
        title={isStatusBarOpen ? '收起状态栏' : '展开状态栏'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
      
      {/* 窗口控制占位 */}
      <div className="w-[68px] flex-shrink-0" />
    </div>
  )
}
