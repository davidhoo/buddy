import { Menu, BrowserWindow, app } from 'electron'

type Language = 'zh-CN' | 'zh-TW' | 'en'

const menuLabels = {
  'en': {
    about: 'About Buddy',
    preferences: 'Preferences...',
    checkForUpdates: 'Check for Updates...',
    services: 'Services',
    hide: 'Hide Buddy',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit Buddy',
    file: 'File',
    newTask: 'New Task',
    closeWindow: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    find: 'Find in Conversation…',
    view: 'View',
    prevTask: 'Previous Task',
    nextTask: 'Next Task',
    toggleSidebar: 'Toggle Sidebar',
    toggleStatusBar: 'Toggle Status Bar',
    reload: 'Reload',
    forceReload: 'Force Reload',
    devTools: 'Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Fullscreen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    bringAllFront: 'Bring All to Front',
    close: 'Close',
    help: 'Help',
    documentation: 'Buddy Documentation',
    whatsNew: "What's New?",
    sendFeedback: 'Send Feedback',
    keyboardShortcuts: 'Keyboard Shortcuts'
  },
  'zh-CN': {
    about: '关于 Buddy',
    preferences: '偏好设置...',
    checkForUpdates: '检查更新...',
    services: '服务',
    hide: '隐藏 Buddy',
    hideOthers: '隐藏其他',
    showAll: '显示全部',
    quit: '退出 Buddy',
    file: '文件',
    newTask: '新建任务',
    closeWindow: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    find: '在对话中查找…',
    view: '视图',
    prevTask: '上一个任务',
    nextTask: '下一个任务',
    toggleSidebar: '切换侧边栏',
    toggleStatusBar: '切换状态栏',
    reload: '重新加载',
    forceReload: '强制重新加载',
    devTools: '开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullscreen: '全屏',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    bringAllFront: '前置全部窗口',
    close: '关闭',
    help: '帮助',
    documentation: 'Buddy 文档',
    whatsNew: '新功能',
    sendFeedback: '发送反馈',
    keyboardShortcuts: '键盘快捷键'
  },
  'zh-TW': {
    about: '關於 Buddy',
    preferences: '偏好設定...',
    checkForUpdates: '檢查更新…',
    services: '服務',
    hide: '隱藏 Buddy',
    hideOthers: '隱藏其他',
    showAll: '顯示全部',
    quit: '結束 Buddy',
    file: '檔案',
    newTask: '新增任務',
    closeWindow: '關閉視窗',
    edit: '編輯',
    undo: '還原',
    redo: '重做',
    cut: '剪下',
    copy: '拷貝',
    paste: '貼上',
    selectAll: '全選',
    find: '在對話中尋找…',
    view: '檢視',
    prevTask: '上一個任務',
    nextTask: '下一個任務',
    toggleSidebar: '切換側邊欄',
    toggleStatusBar: '切換狀態列',
    reload: '重新載入',
    forceReload: '強制重新載入',
    devTools: '開發者工具',
    actualSize: '實際大小',
    zoomIn: '放大',
    zoomOut: '縮小',
    fullscreen: '全螢幕',
    window: '視窗',
    minimize: '最小化',
    zoom: '縮放',
    bringAllFront: '將全部移至最前',
    close: '關閉',
    help: '說明',
    documentation: 'Buddy 文件',
    whatsNew: '新功能',
    sendFeedback: '傳送意見回饋',
    keyboardShortcuts: '鍵盤快速鍵'
  }
} as const

let currentLang: Language = 'zh-CN'
let cachedMainWindow: BrowserWindow | null = null

function getLabels() {
  return menuLabels[currentLang] ?? menuLabels['en']
}

function buildMenu(): Menu {
  const t = getLabels()
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: t.about },
        { type: 'separator' },
        {
          label: t.preferences,
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('openSettings')
        },
        { type: 'separator' },
        {
          label: t.checkForUpdates,
          click: () => sendMenuAction('checkForUpdates')
        },
        { type: 'separator' },
        { role: 'services', label: t.services },
        { type: 'separator' },
        { role: 'hide', label: t.hide },
        { role: 'hideOthers', label: t.hideOthers },
        { role: 'unhide', label: t.showAll },
        { type: 'separator' },
        { role: 'quit', label: t.quit }
      ]
    },
    {
      label: t.file,
      submenu: [
        {
          label: t.newTask,
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('newTask')
        },
        { type: 'separator' },
        { role: 'close', label: t.closeWindow }
      ]
    },
    {
      label: t.edit,
      submenu: [
        { role: 'undo', label: t.undo },
        { role: 'redo', label: t.redo },
        { type: 'separator' },
        { role: 'cut', label: t.cut },
        { role: 'copy', label: t.copy },
        { role: 'paste', label: t.paste },
        { role: 'selectAll', label: t.selectAll },
        { type: 'separator' },
        {
          label: t.find,
          accelerator: 'CmdOrCtrl+F',
          click: () => sendMenuAction('find')
        }
      ]
    },
    {
      label: t.view,
      submenu: [
        {
          label: t.prevTask,
          accelerator: 'CmdOrCtrl+Shift+[',
          click: () => sendMenuAction('prevTask')
        },
        {
          label: t.nextTask,
          accelerator: 'CmdOrCtrl+Shift+]',
          click: () => sendMenuAction('nextTask')
        },
        { type: 'separator' },
        {
          label: t.toggleSidebar,
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggleSidebar')
        },
        {
          label: t.toggleStatusBar,
          accelerator: 'CmdOrCtrl+Alt+B',
          click: () => sendMenuAction('toggleStatusBar')
        },
        { type: 'separator' },
        { role: 'reload', label: t.reload },
        { role: 'forceReload', label: t.forceReload },
        { role: 'toggleDevTools', label: t.devTools },
        { type: 'separator' },
        { role: 'resetZoom', label: t.actualSize },
        { role: 'zoomIn', label: t.zoomIn },
        { role: 'zoomOut', label: t.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullscreen }
      ]
    },
    {
      label: t.window,
      submenu: [
        { role: 'minimize', label: t.minimize },
        { role: 'zoom', label: t.zoom },
        { type: 'separator' },
        { role: 'front', label: t.bringAllFront },
        { role: 'close', label: t.close }
      ]
    },
    {
      label: t.help,
      role: 'help',
      submenu: [
        {
          label: t.documentation,
          enabled: false
        },
        {
          label: t.whatsNew,
          enabled: false
        },
        {
          label: t.sendFeedback,
          enabled: false
        },
        { type: 'separator' },
        {
          label: t.keyboardShortcuts,
          accelerator: 'CmdOrCtrl+/',
          click: () => sendMenuAction('showKeyboardShortcuts')
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

function sendMenuAction(action: string): void {
  if (cachedMainWindow && !cachedMainWindow.isDestroyed()) {
    cachedMainWindow.webContents.send('menu:action', action)
  }
}

export function setupMenu(mainWindow: BrowserWindow): void {
  cachedMainWindow = mainWindow
  const menu = buildMenu()
  Menu.setApplicationMenu(menu)
}

export function updateMenuLanguage(lang: string): void {
  if (lang !== 'zh-CN' && lang !== 'zh-TW' && lang !== 'en') return
  if (lang === currentLang) return
  currentLang = lang
  const menu = buildMenu()
  Menu.setApplicationMenu(menu)
}
