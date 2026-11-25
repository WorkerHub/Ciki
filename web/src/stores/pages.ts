import { create } from "zustand"
import {
  describeApiError,
  type PageDetail,
  type PageNode,
  pagesApi
} from "@/lib/api"
import {
  findNode,
  findPath,
  needsRenumber,
  placeNodeInTree,
  pruneNodeFromTree,
  siblingsOf,
  sortSiblings
} from "@/lib/tree"

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] }

interface PagesState {
  tree: PageNode[]
  /** 当前页面树所属空间；null = 走后端缺省的默认空间。 */
  spaceId: number | null
  loading: boolean
  error: string | null
  expanded: number[]
  load: (spaceId?: number | null) => Promise<void>
  toggle: (id: number) => void
  expand: (id: number) => void
  expandTo: (id: number) => void
  createPage: (title: string, parentId: number | null) => Promise<PageDetail>
  renamePage: (id: number, title: string) => Promise<void>
  movePage: (
    id: number,
    parentId: number | null,
    sortOrder: number
  ) => Promise<void>
  movePageTo: (
    id: number,
    targetSpaceId: number,
    parentId: number | null,
    sortOrder: number
  ) => Promise<void>
  removePage: (id: number) => Promise<void>
  restorePage: (id: number) => Promise<void>
  purgePage: (id: number) => Promise<void>
}

/**
 * 页面树状态。所有写操作后都重拉一次整棵树 —— 层级/排序的真相在服务端，
 * 前端不自己拼一份「乐观树」，避免与 sortOrder 对不上。
 * move 之后如果同级出现重复 sortOrder（服务端只改被移动页时可能发生），
 * 客户端按当前显示顺序把这一级重排成 0..n-1。
 */
export const usePagesStore = create<PagesState>((set, get) => {
  let moveQueue: Promise<void> = Promise.resolve()
  let pendingMoves = 0

  const repairOrder = async (parentIds: (number | null)[]) => {
    for (const parentId of parentIds) {
      const siblings = siblingsOf(get().tree, parentId)
      if (!needsRenumber(siblings)) continue
      for (const [index, sibling] of sortSiblings(siblings).entries()) {
        if (sibling.sortOrder !== index)
          await pagesApi.move(sibling.id, parentId, index)
      }
    }
  }

  const load = async (spaceId?: number | null) => {
    // 省略参数 = 沿用当前空间（写操作后重拉）；显式传 null = 走后端缺省的默认空间
    const next = spaceId === undefined ? get().spaceId : spaceId
    const switching = next !== get().spaceId
    if (switching) {
      pendingMoves = 0
    }
    set({
      loading: true,
      error: null,
      spaceId: next,
      // 换空间时先清掉旧树：不能让 A 空间的页面在 B 空间的标题下露一下
      ...(switching ? { tree: [], expanded: [] } : {})
    })
    try {
      const tree = await pagesApi.tree(next)
      set({ tree, loading: false })
    } catch (error) {
      set({
        loading: false,
        error: describeApiError(error)
      })
    }
  }

  return {
    tree: [],
    spaceId: null,
    loading: true,
    error: null,
    expanded: [],

    load,

    toggle: (id) =>
      set((state) => ({
        expanded: state.expanded.includes(id)
          ? state.expanded.filter((item) => item !== id)
          : [...state.expanded, id]
      })),

    expand: (id) =>
      set((state) =>
        state.expanded.includes(id)
          ? state
          : { expanded: [...state.expanded, id] }
      ),

    expandTo: (id) => {
      const path = findPath(get().tree, id)
      if (!path.length) return
      const ancestors = path.slice(0, -1).map((node) => node.id)
      set((state) => ({
        expanded: Array.from(new Set([...state.expanded, ...ancestors]))
      }))
    },

    createPage: async (title, parentId) => {
      const page = await pagesApi.create({
        title,
        parentId,
        contentJson: JSON.stringify(EMPTY_DOC),
        contentHtml: "",
        contentText: "",
        ...(get().spaceId !== null ? { spaceId: get().spaceId as number } : {})
      })
      await load()
      if (parentId !== null) get().expand(parentId)
      return page
    },

    renamePage: async (id, title) => {
      const tree = get().tree
      const node = findNode(tree, id)
      if (!node) return
      // 改名只是换标题，但 PUT /pages/:id 的契约要求带正文三件套：
      // 正文 JSON 只在 R2 里，得先按 content_hash 取一次（列表不缓正文）。
      const detail = await pagesApi.getForEditor(id)
      await pagesApi.update(id, {
        title,
        contentJson: detail.contentJson,
        contentHtml: detail.contentHtml,
        contentText: detail.contentText
      })
      await load()
    },

    movePage: async (id, parentId, sortOrder) => {
      const currentSpace = get().spaceId
      const beforeNode = findNode(get().tree, id)
      const beforeParentId = beforeNode?.parentId ?? null
      const previousTree = get().tree

      // 1. 同步乐观更新本地树结构，同帧呈现新顺序
      set({ tree: placeNodeInTree(get().tree, id, parentId, sortOrder) })
      if (parentId !== null) get().expand(parentId)

      pendingMoves++

      // 2. 后台同步任务串行排队，避免并发踩踏
      const task = (async () => {
        await moveQueue.catch(() => {})
        let moveFailed = false

        try {
          await pagesApi.move(id, parentId, sortOrder)
          await repairOrder([parentId, beforeParentId])
        } catch (error) {
          moveFailed = true
          // 本笔同步失败，回滚到本次拖放前的顺序（若期间切空间则不覆写新空间树）
          if (get().spaceId === currentSpace) {
            set({ tree: previousTree })
          }
          throw error
        } finally {
          if (pendingMoves > 0) {
            pendingMoves--
          }
          // 3. 所有排队的移动都完成后，收敛拉取服务端最终态
          if (pendingMoves === 0 && !moveFailed) {
            try {
              if (get().spaceId === currentSpace) {
                const finalTree = await pagesApi.tree(currentSpace)
                if (pendingMoves === 0 && get().spaceId === currentSpace) {
                  set({ tree: finalTree })
                }
              }
            } catch {
              // 收敛拉取网络偶发失败不覆盖本地成功的乐观状态
            }
          }
        }
      })()

      moveQueue = task
      return task
    },

    movePageTo: async (id, targetSpaceId, parentId, sortOrder) => {
      const currentSpace = get().spaceId
      const isSameSpace = targetSpaceId === currentSpace
      const beforeNode = findNode(get().tree, id)
      const beforeParentId = beforeNode?.parentId ?? null
      const previousTree = get().tree

      // 1. 同步乐观更新：同空间落位，跨空间从当前树移出
      if (isSameSpace) {
        set({ tree: placeNodeInTree(get().tree, id, parentId, sortOrder) })
        if (parentId !== null) get().expand(parentId)
      } else {
        set({ tree: pruneNodeFromTree(get().tree, id) })
      }

      pendingMoves++

      // 2. 后台同步任务串行排队
      const task = (async () => {
        await moveQueue.catch(() => {})
        let moveFailed = false

        try {
          await pagesApi.move(id, parentId, sortOrder, targetSpaceId)
          await repairOrder([parentId, beforeParentId])
        } catch (error) {
          moveFailed = true
          if (get().spaceId === currentSpace) {
            set({ tree: previousTree })
          }
          throw error
        } finally {
          if (pendingMoves > 0) {
            pendingMoves--
          }
          if (pendingMoves === 0 && !moveFailed) {
            try {
              if (get().spaceId === currentSpace) {
                const finalTree = await pagesApi.tree(currentSpace)
                if (pendingMoves === 0 && get().spaceId === currentSpace) {
                  set({ tree: finalTree })
                }
              }
            } catch {
              // 忽略收敛拉取的偶发网络错误
            }
          }
        }
      })()

      moveQueue = task
      return task
    },

    removePage: async (id) => {
      await pagesApi.remove(id)
      await load()
    },

    restorePage: async (id) => {
      await pagesApi.restore(id)
      await load()
    },

    purgePage: async (id) => {
      await pagesApi.removePermanent(id)
      await load()
    }
  }
})
