import { create } from "zustand"
import { siteApi } from "@/lib/api"

/** 后端 DTO 的默认站点名；公开接口失败时保持它，页面不因缺字段白屏。 */
export const DEFAULT_SITE_NAME = "Ciki"

interface SiteState {
  name: string
  /**
   * 站点是否配好了发信（SMTP），公开配置项。邮箱验证码类入口（设置页的邮箱
   * 2FA）靠它决定可不可点：false 时入口直接不可用并提示去向，不做点了才报错。
   */
  emailConfigured: boolean
  loaded: boolean
  /** 公开读一次站点信息；失败保留现值（例如旧后端没有 siteName）。 */
  load: () => Promise<void>
  /** 系统管理保存成功后调用，品牌区/页签标题/登录页立即跟着变。 */
  setName: (name: string) => void
}

export const useSiteStore = create<SiteState>((set) => ({
  name: DEFAULT_SITE_NAME,
  emailConfigured: false,
  loaded: false,

  load: async () => {
    try {
      const config = await siteApi.get()
      const name = config.siteName?.trim()
      set((state) => ({
        name: name || state.name,
        emailConfigured: config.emailConfigured,
        loaded: true
      }))
    } catch {
      set({ loaded: true })
    }
  },

  setName: (name) => {
    set({ name: name.trim() || DEFAULT_SITE_NAME, loaded: true })
  }
}))
