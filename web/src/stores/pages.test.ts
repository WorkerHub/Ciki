import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PageNode } from "@/lib/api"
import { usePagesStore } from "@/stores/pages"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: {
      ...actual.pagesApi,
      tree: vi.fn(),
      move: vi.fn(),
      create: vi.fn()
    }
  }
})

const { pagesApi } = await import("@/lib/api")

function node(
  id: number,
  title: string,
  sortOrder: number,
  children: PageNode[] = [],
  parentId: number | null = null
): PageNode {
  return {
    id,
    title,
    sortOrder,
    parentId,
    updatedAt: "2026-11-25T00:00:00.000Z",
    children
  }
}

describe("pages store: movePage / movePageTo 乐观更新", () => {
  const initialTree: PageNode[] = [
    node(1, "A", 0, [node(2, "A1", 0, [], 1), node(3, "A2", 1, [], 1)]),
    node(4, "B", 1),
    node(5, "C", 2)
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pagesApi.tree).mockResolvedValue(initialTree)
    vi.mocked(pagesApi.move).mockResolvedValue({ success: true })
    usePagesStore.setState({
      tree: initialTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: [1]
    })
  })

  it("正常网络：调用 movePage 时本地 tree 同步立刻更新为新顺序，后台完成同步", async () => {
    vi.mocked(pagesApi.move).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.tree).mockResolvedValue([
      node(5, "C", 0),
      node(1, "A", 1, [node(2, "A1", 0, [], 1), node(3, "A2", 1, [], 1)]),
      node(4, "B", 2)
    ])

    // C (id: 5) 移到首位 index 0
    const movePromise = usePagesStore.getState().movePage(5, null, 0)

    // 关键断言：同帧同步呈现，无需等待 promise resolve
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([5, 1, 4])
    expect(usePagesStore.getState().tree.map((n) => n.sortOrder)).toEqual([
      0, 1, 2
    ])

    await movePromise

    expect(pagesApi.move).toHaveBeenCalledWith(5, null, 0)
    expect(pagesApi.tree).toHaveBeenCalledWith(1)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([5, 1, 4])
  })

  it("节流网络：在服务端响应前持续保持乐观顺序，响应后顺序不跳动", async () => {
    let resolveMove: () => void = () => {}
    const delayedMove = new Promise<{ success: true }>((resolve) => {
      resolveMove = () => resolve({ success: true })
    })
    vi.mocked(pagesApi.move).mockReturnValue(delayedMove)
    vi.mocked(pagesApi.tree).mockResolvedValue([
      node(4, "B", 0),
      node(5, "C", 1),
      node(1, "A", 2, [node(2, "A1", 0, [], 1), node(3, "A2", 1, [], 1)])
    ])

    const movePromise = usePagesStore.getState().movePage(1, null, 2)

    // 调用后立即是新顺序
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([4, 5, 1])

    // 模拟网络延迟中...
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([4, 5, 1])

    // 服务端响应返回
    resolveMove()
    await movePromise

    // 最终收敛拉取后顺序依然保持不变，无回弹与跳动
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([4, 5, 1])
  })

  it("失败回滚：接口报错时自动回滚到拖动前顺序并抛出错误", async () => {
    vi.mocked(pagesApi.move).mockRejectedValue(new Error("Network Error"))

    const movePromise = usePagesStore.getState().movePage(5, null, 0)

    // 松手时短暂呈现新顺序
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([5, 1, 4])

    // 等待接口报错
    await expect(movePromise).rejects.toThrow("Network Error")

    // 失败后立即回滚到拖放前顺序
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([1, 4, 5])
  })

  it("连续快速多次拖放不得互相踩踏：中间不被旧数据冲掉，全部完成后顺序与服务端一致", async () => {
    let resolveMove1: () => void = () => {}
    const delayedMove1 = new Promise<{ success: true }>((resolve) => {
      resolveMove1 = () => resolve({ success: true })
    })
    let resolveMove2: () => void = () => {}
    const delayedMove2 = new Promise<{ success: true }>((resolve) => {
      resolveMove2 = () => resolve({ success: true })
    })

    vi.mocked(pagesApi.move)
      .mockReturnValueOnce(delayedMove1)
      .mockReturnValueOnce(delayedMove2)

    vi.mocked(pagesApi.tree).mockResolvedValue([
      node(4, "B", 0),
      node(5, "C", 1),
      node(1, "A", 2, [node(2, "A1", 0, [], 1), node(3, "A2", 1, [], 1)])
    ])

    // 第 1 次拖动：把 C (5) 移到第 0 位 -> [5, 1, 4]
    const p1 = usePagesStore.getState().movePage(5, null, 0)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([5, 1, 4])

    // 第 2 次快速拖动：把 B (4) 移到第 0 位 -> [4, 5, 1]
    const p2 = usePagesStore.getState().movePage(4, null, 0)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([4, 5, 1])

    // Move 1 响应返回
    resolveMove1()
    await p1

    // 关键点：Move 1 完成时不得触发收敛拉取冲掉 Move 2 的乐观状态
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([4, 5, 1])
    expect(pagesApi.tree).not.toHaveBeenCalled()

    // Move 2 响应返回
    resolveMove2()
    await p2

    // 全部完成后才触发一次收敛拉取，最终顺序与服务端一致
    expect(pagesApi.tree).toHaveBeenCalledTimes(1)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([4, 5, 1])
  })

  it("movePageTo 跨空间移动：当前树乐观移除该页面，失败时回滚", async () => {
    vi.mocked(pagesApi.move).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.tree).mockResolvedValue([
      node(1, "A", 0, [node(2, "A1", 0, [], 1), node(3, "A2", 1, [], 1)]),
      node(5, "C", 1)
    ])

    // 将 B (id: 4) 移动到目标空间 2
    const p = usePagesStore.getState().movePageTo(4, 2, null, 0)

    // 乐观更新：当前树立即不再包含 4
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([1, 5])

    await p
    expect(pagesApi.move).toHaveBeenCalledWith(4, null, 0, 2)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([1, 5])
  })

  it("连续拖放中第 1 笔成功、第 2 笔失败：只回滚第 2 笔，保留第 1 笔成果", async () => {
    let resolveMove1: () => void = () => {}
    const delayedMove1 = new Promise<{ success: true }>((resolve) => {
      resolveMove1 = () => resolve({ success: true })
    })

    vi.mocked(pagesApi.move)
      .mockReturnValueOnce(delayedMove1)
      .mockRejectedValueOnce(new Error("Move 2 Failed"))

    // 服务端最终态为第 1 笔成功后的树：[5, 1, 4]
    vi.mocked(pagesApi.tree).mockResolvedValue([
      node(5, "C", 0),
      node(1, "A", 1, [node(2, "A1", 0, [], 1), node(3, "A2", 1, [], 1)]),
      node(4, "B", 2)
    ])

    // 第 1 笔移动：C(5) 移到首位 -> [5, 1, 4]
    const p1 = usePagesStore.getState().movePage(5, null, 0)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([5, 1, 4])

    // 第 2 笔移动：B(4) 移到首位 -> [4, 5, 1]
    const p2 = usePagesStore.getState().movePage(4, null, 0)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([4, 5, 1])

    // 第 1 笔成功
    resolveMove1()
    await p1

    // 第 2 笔失败被 reject
    await expect(p2).rejects.toThrow("Move 2 Failed")

    // 关键断言：第 2 笔失败只回滚第 2 笔，不抹掉第 1 笔成果，最终收敛为第 1 笔成功态
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([5, 1, 4])
  })

  it("移动在途期间切换空间：旧空间收敛拉取不得覆盖新空间树", async () => {
    let resolveMove: () => void = () => {}
    const delayedMove = new Promise<{ success: true }>((resolve) => {
      resolveMove = () => resolve({ success: true })
    })
    vi.mocked(pagesApi.move).mockReturnValueOnce(delayedMove)

    // 在空间 1 发起移动
    const movePromise = usePagesStore.getState().movePage(5, null, 0)

    // 在途期间用户切换到空间 2
    const space2Tree = [node(100, "Space2 Root", 0)]
    vi.mocked(pagesApi.tree).mockResolvedValue(space2Tree)
    await usePagesStore.getState().load(2)

    expect(usePagesStore.getState().spaceId).toBe(2)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([100])

    // 旧空间 1 的移动响应返回
    resolveMove()
    await movePromise

    // 关键断言：旧空间 1 的收敛拉取被空间校验守卫拦截，新空间 2 的树保持完整未被覆盖
    expect(usePagesStore.getState().spaceId).toBe(2)
    expect(usePagesStore.getState().tree.map((n) => n.id)).toEqual([100])
  })
})
