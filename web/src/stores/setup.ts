import { create } from "zustand"
import { type SetupState, setupApi } from "@/lib/api"

/**
 * 站点初始化状态：RootGate（全站门槛）与 SetupPage（初始化页）共用同一份。
 *
 * 之所以不放在 RootGate 的 useState 里：初始化成功后 RootGate 必须立刻知道
 * `initialized: true`，否则点「注册首个管理员」会被自己的重定向拉回 /setup。
 */
interface SetupGateState {
  state: SetupState | "error" | null
  loading: boolean
  /** 重新向服务端要一次状态；初始化成功后调用，拿到真实的 initialized/enabled。 */
  load: () => Promise<SetupState | "error">
}

export const useSetupGateStore = create<SetupGateState>((set) => ({
  state: null,
  loading: false,
  load: async () => {
    set({ loading: true })
    try {
      const state = await setupApi.state()
      set({ state, loading: false })
      return state
    } catch {
      const state = "error" as const
      set({ state, loading: false })
      return state
    }
  }
}))
