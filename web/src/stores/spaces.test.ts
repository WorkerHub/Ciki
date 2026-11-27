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
    vi.mocked(spacesApi.create).mockReset()
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

  it("存储含非法 currentId 时，rehydrate 回退为 null", async () => {
    localStorage.setItem(
      SPACE_STORAGE_KEY,
      JSON.stringify({
        state: { currentId: "invalid-id" },
        version: 0
      })
    )
    await useSpacesStore.persist.rehydrate()
    expect(useSpacesStore.getState().currentId).toBeNull()

    localStorage.setItem(
      SPACE_STORAGE_KEY,
      JSON.stringify({
        state: { currentId: -5 },
        version: 0
      })
    )
    await useSpacesStore.persist.rehydrate()
    expect(useSpacesStore.getState().currentId).toBeNull()
  })

  it("新建空间：未传 slug 时 payload 不含 slug，新空间入列表并成为当前空间", async () => {
    const newSpace: Space = { ...defaultSpace, id: 3, slug: "team-new", name: "新团队" }
    vi.mocked(spacesApi.create).mockResolvedValue(newSpace)

    const result = await useSpacesStore.getState().create("新团队", "描述")

    expect(spacesApi.create).toHaveBeenCalledWith({
      name: "新团队",
      description: "描述"
    })
    expect(result).toEqual(newSpace)
    expect(useSpacesStore.getState().currentId).toBe(3)
    expect(useSpacesStore.getState().spaces).toContainEqual(newSpace)
  })

  it("新建空间：指定非空 slug 时 payload 携带 slug", async () => {
    const customSpace: Space = { ...defaultSpace, id: 4, slug: "custom-slug", name: "自定义" }
    vi.mocked(spacesApi.create).mockResolvedValue(customSpace)

    await useSpacesStore.getState().create("自定义", "", "custom-slug")

    expect(spacesApi.create).toHaveBeenCalledWith({
      name: "自定义",
      description: "",
      slug: "custom-slug"
    })
    expect(useSpacesStore.getState().currentId).toBe(4)
  })
})
