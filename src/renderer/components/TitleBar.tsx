interface TitleBarProps {
  taskName: string
  isSidebarOpen: boolean
  isStatusBarOpen: boolean
  showToggles?: boolean
  bare?: boolean
  onToggleSidebar: () => void
  onToggleStatusBar: () => void
}

export function TitleBar({
  taskName,
  isSidebarOpen,
  isStatusBarOpen,
  showToggles = true,
  bare = false,
  onToggleSidebar,
  onToggleStatusBar
}: TitleBarProps) {
  return (
    <div className={`h-[50px] flex items-center px-4 bg-bg-elevated drag-region ${bare ? '' : 'border-b border-border'}`}>
      {/* 红绿灯 + 展开按钮（仅在侧边栏关闭时显示，否则它们在侧边栏顶部） */}
      {!isSidebarOpen && (
        <>
          <div className="w-[68px] flex-shrink-0" />
          {showToggles && (
            <button
              onClick={onToggleSidebar}
              className="w-5 h-5 mt-[4px] flex items-center justify-center rounded hover:bg-bg-muted no-drag"
              title="展开侧边栏"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          )}
        </>
      )}

      {/* 任务名（左对齐） */}
      <div className="flex-1 text-sm font-medium truncate px-4">
        {bare ? '' : (taskName || 'buddy')}
      </div>

      {/* 右侧栏切换按钮（最右侧，右对齐） */}
      {showToggles && (
        <button
          onClick={onToggleStatusBar}
          className="w-5 h-5 mt-[4px] flex items-center justify-center rounded hover:bg-bg-muted no-drag"
          title={isStatusBarOpen ? '收起状态栏' : '展开状态栏'}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </button>
      )}
    </div>
  )
}
