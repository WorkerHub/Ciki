import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { describeApiError, type Space, spacesApi } from "@/lib/api"
import { pickInitialSpace } from "@/lib/space"

/**
 * 空间列表 + 当前空间（本机偏好）。
 *
 * - 列表每次进入应用从 `GET /api/spaces` 拉：后端已按成员资格过滤，前端不再筛。
 * - `currentId` 用 zustand persist 存 localStorage（与 `ciki-theme` 同一路数），
 *   刷新后保持；列表到手时若它已失效（空间被删 / 不再是成员）回落到默认空间。
 * - 页面树不在这里管：`AppShell` 订阅 `currentId` 的变化去拉对应空间的树。
 */
export const SPACE_STORAGE_KEY = "ciki-space"

interface SpacesState {
  spaces: Space[]
  status: "loading" | "ready" | "error"
  error: string | null
  currentId: number | null
  load: () => Promise<void>
  select: (id: number) => void
  create: (name: string, description: string) => Promise<Space>
  upsert: (space: Space) => void
  remove: (id: number) => Promise<void>
}

export const useSpacesStore = create<SpacesState>()(
  persist(
    (set, get) => ({
      spaces: [],
      status: "loading",
      error: null,
      currentId: null,

      load: async () => {
        set({ status: "loading", error: null, spaces: [] })
        try {
          const spaces = await spacesApi.list()
          const current = pickInitialSpace(spaces, get().currentId)
          set({ spaces, currentId: current?.id ?? null, status: "ready" })
        } catch (error) {
          set({
            status: "error",
            error: describeApiError(error),
            spaces: []
          })
        }
      },

      select: (id) => set({ currentId: id }),

      create: async (name, description) => {
        const space = await spacesApi.create({ name, description })
        set((state) => ({
          spaces: [...state.spaces, space],
          currentId: space.id
        }))
        return space
      },

      upsert: (space) =>
        set((state) => ({
          spaces: state.spaces.map((item) =>
            item.id === space.id ? space : item
          )
        })),

      remove: async (id) => {
        await spacesApi.remove(id)
        const left = get().spaces.filter((space) => space.id !== id)
        const next = pickInitialSpace(
          left,
          get().currentId === id ? null : get().currentId
        )
        set({ spaces: left, currentId: next?.id ?? null })
      }
    }),
    {
      name: SPACE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ currentId: state.currentId })
    }
  )
)
