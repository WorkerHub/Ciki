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
  siblingsOf,
  sortSiblings
} from "@/lib/tree"

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] }

interface PagesState {
  tree: PageNode[]
  /** 当前页面树所属空间；null = 走后端缺省的默认空间。 */
  spaceId: string | null
  loading: boolean
  error: string | null
  expanded: string[]
  load: (spaceId?: string | null) => Promise<void>
  toggle: (id: string) => void
  expand: (id: string) => void
  expandTo: (id: string) => void
  createPage: (title: string, parentId: string | null) => Promise<PageDetail>
  renamePage: (id: string, title: string) => Promise<void>
  movePage: (
    id: string,
    parentId: string | null,
    sortOrder: number
  ) => Promise<void>
  movePageToSpace: (id: string, targetSpaceId: string) => Promise<void>
  removePage: (id: string) => Promise<void>
  restorePage: (id: string) => Promise<void>
  purgePage: (id: string) => Promise<void>
}

/**
 * 页面树状态。所有写操作后都重拉一次整棵树 —— 层级/排序的真相在服务端，
 * 前端不自己拼一份「乐观树」，避免与 sortOrder 对不上。
 * move 之后如果同级出现重复 sortOrder（服务端只改被移动页时可能发生），
 * 客户端按当前显示顺序把这一级重排成 0..n-1。
 */
export const usePagesStore = create<PagesState>((set, get) => {
  const repairOrder = async (parentIds: (string | null)[]) => {
    for (const parentId of parentIds) {
      const siblings = siblingsOf(get().tree, parentId)
      if (!needsRenumber(siblings)) continue
      for (const [index, sibling] of sortSiblings(siblings).entries()) {
        if (sibling.sortOrder !== index)
          await pagesApi.move(sibling.id, parentId, index)
      }
    }
  }

  const load = async (spaceId?: string | null) => {
    // 省略参数 = 沿用当前空间（写操作后重拉）；显式传 null = 走后端缺省的默认空间
    const next = spaceId === undefined ? get().spaceId : spaceId
    const switching = next !== get().spaceId
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
        ...(get().spaceId ? { spaceId: get().spaceId as string } : {})
      })
      await load()
      if (parentId) get().expand(parentId)
      return page
    },

    renamePage: async (id, title) => {
      const tree = get().tree
      const node = findNode(tree, id)
      if (!node) return
      const detail = await pagesApi.get(id)
      await pagesApi.update(id, {
        title,
        contentJson: detail.contentJson,
        contentHtml: detail.contentHtml,
        contentText: detail.contentText
      })
      await load()
    },

    movePage: async (id, parentId, sortOrder) => {
      const before = findNode(get().tree, id)
      await pagesApi.move(id, parentId, sortOrder)
      await load()
      await repairOrder([parentId, before?.parentId ?? null])
      await load()
      if (parentId) get().expand(parentId)
    },

    movePageToSpace: async (id, targetSpaceId) => {
      await pagesApi.move(id, null, undefined, targetSpaceId)
      // 源空间的树先重拉：页面从当前树里消失（目标空间由调用方切换后加载）
      await load()
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
