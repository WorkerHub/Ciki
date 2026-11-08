import { create } from "zustand"
import { siteApi } from "@/lib/api"

/** 后端 DTO 的默认站点名；公开接口失败时保持它，页面不因缺字段白屏。 */
export const DEFAULT_SITE_NAME = "Ciki"

interface SiteState {
  name: string
  loaded: boolean
  /** 公开读一次站点名；失败保留现值（例如旧后端没有 siteName）。 */
  load: () => Promise<void>
  /** 系统管理保存成功后调用，品牌区/页签标题/登录页立即跟着变。 */
  setName: (name: string) => void
}

export const useSiteStore = create<SiteState>((set) => ({
  name: DEFAULT_SITE_NAME,
  loaded: false,

  load: async () => {
    try {
      const { siteName } = await siteApi.get()
      const name = siteName?.trim()
      if (name) set({ name, loaded: true })
      else set({ loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  setName: (name) => {
    set({ name: name.trim() || DEFAULT_SITE_NAME, loaded: true })
  }
}))
