import { beforeEach, describe, expect, it } from "vitest"
import {
  readSidebarOpen,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_OPEN_STORAGE_KEY,
  writeSidebarOpen
} from "@/lib/sidebar"

describe("sidebar lib: 侧栏状态与配置", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("默认展开状态为 true", () => {
    expect(readSidebarOpen()).toBe(true)
  })

  it("明确写入 false 时返回 false", () => {
    writeSidebarOpen(false)
    expect(localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)).toBe("false")
    expect(readSidebarOpen()).toBe(false)
  })

  it("写入 true 时返回 true", () => {
    writeSidebarOpen(false)
    expect(readSidebarOpen()).toBe(false)
    writeSidebarOpen(true)
    expect(localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)).toBe("true")
    expect(readSidebarOpen()).toBe(true)
  })

  it("非法值回退为 true", () => {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, "invalid")
    expect(readSidebarOpen()).toBe(true)
  })

  it("宽度限制范围为 200–420px", () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(200)
    expect(SIDEBAR_MAX_WIDTH).toBe(420)
  })
})
