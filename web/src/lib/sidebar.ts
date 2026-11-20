/**
 * 侧栏宽度与收起状态的持久化。
 *
 * 只存本机：localStorage 的 `app-sidebar-open`，不进用户属性、不随账号同步。
 * 开合状态只有明确的 `"false"` 才算收起，缺失或非法一律按展开（与默认展开一致）。
 * 宽度由 react-resizable-panels 的 useDefaultLayout（ciki-shell）管理，范围限定在 [200, 420] 像素。
 */
export const SIDEBAR_OPEN_STORAGE_KEY = "app-sidebar-open"

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 420
export const SIDEBAR_DEFAULT_SIZE = "18%"

/** 读开合状态：只有明确写过 `"false"` 才收起，其余按展开。 */
export function readSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export function writeSidebarOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open))
  } catch {
    // 存储不可用（隐私模式等）只影响下次刷新，不打断交互。
  }
}
