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
  /**
   * 公开读一次站点信息；失败保留现值（例如旧后端没有 siteName）。
   * 系统管理保存 SMTP 配置后调它一次，`emailConfigured` 会跟着刷新，
   * 用户安全设置页不必强刷浏览器才会变成可用。
   */
  load: () => Promise<void>
  /** 系统管理保存成功后调用，品牌区/页签标题/登录页立即跟着变。 */
  setName: (name: string) => void
  /**
   * 已知发信状态时直接同步（如服务端回 `EMAIL_NOT_CONFIGURED`、或保存 SMTP
   * 后不想多发一次 config 请求），不用等下一次 `load()`。
   */
  setEmailConfigured: (configured: boolean) => void
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
  },

  setEmailConfigured: (configured) => {
    set({ emailConfigured: configured })
  }
}))
