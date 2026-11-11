import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Space } from "@/lib/api"
import { SPACE_STORAGE_KEY, useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    spacesApi: {
      ...actual.spacesApi,
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn()
    }
  }
})

const { spacesApi } = await import("@/lib/api")

const defaultSpace: Space = {
  id: 1,
  slug: "default",
  name: "默认空间",
  description: "",
  myRole: "editor",
  isDefault: true,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

const secondSpace: Space = {
  ...defaultSpace,
  id: 2,
  slug: "space-2",
  name: "支付团队",
  myRole: "admin",
  isDefault: false
}

describe("空间 store：本机偏好与回落", () => {
  beforeEach(() => {
    localStorage.clear()
    useSpacesStore.setState({
      spaces: [],
      status: "loading",
      error: null,
      currentId: null
    })
    vi.mocked(spacesApi.list).mockReset()
    vi.mocked(spacesApi.remove).mockReset()
  })

  it("持久化的空间 id 仍可见时保留它", async () => {
    useSpacesStore.setState({ currentId: 2 })
    vi.mocked(spacesApi.list).mockResolvedValue([defaultSpace, secondSpace])

    await useSpacesStore.getState().load()

    expect(useSpacesStore.getState().currentId).toBe(2)
    expect(useSpacesStore.getState().spaces).toHaveLength(2)
    expect(useSpacesStore.getState().status).toBe("ready")
  })

  it("持久化的空间已不可见（被删 / 被移出成员）时回落默认空间", async () => {
    useSpacesStore.setState({ currentId: 99 })
    vi.mocked(spacesApi.list).mockResolvedValue([defaultSpace, secondSpace])

    await useSpacesStore.getState().load()

    expect(useSpacesStore.getState().currentId).toBe(1)
  })

  it("切换空间写进 localStorage（ciki-space），刷新后仍记得", () => {
    useSpacesStore.setState({ spaces: [defaultSpace, secondSpace] })

    useSpacesStore.getState().select(2)

    const raw = localStorage.getItem(SPACE_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).state.currentId).toBe(2)
  })

  it("空间列表加载失败时进入 error，不抛异常", async () => {
    vi.mocked(spacesApi.list).mockRejectedValue(new Error("boom"))

    await useSpacesStore.getState().load()

    expect(useSpacesStore.getState().status).toBe("error")
    expect(useSpacesStore.getState().spaces).toEqual([])
    expect(useSpacesStore.getState().error).toBeTruthy()
  })

  it("删除当前空间后选中剩下的默认空间", async () => {
    useSpacesStore.setState({
      spaces: [defaultSpace, secondSpace],
      status: "ready",
      currentId: 2
    })
    vi.mocked(spacesApi.remove).mockResolvedValue({ success: true })

    await useSpacesStore.getState().remove(2)

    expect(useSpacesStore.getState().currentId).toBe(1)
    expect(useSpacesStore.getState().spaces.map((item) => item.id)).toEqual([1])
  })
})
