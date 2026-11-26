import type { ThemeStyle } from "@/lib/theme"

export interface HtmlEmbedNodeAttrs {
  /** R2 文件 key，形如 "embeds/<uuid>.html" */
  key: string
  /** 展示高度（像素），null 表示自动贴合，填数表示固定高度（手填 clamp 200–2000） */
  height: number | null
  /** 原始文件名 */
  name: string
}

/** 消息协议类型：与后端单逐字一致（冻结） */
export const CIKI_EMBED_HEIGHT_MESSAGE_TYPE = "ciki-embed-height" as const

export interface CikiEmbedHeightMessage {
  type: typeof CIKI_EMBED_HEIGHT_MESSAGE_TYPE
  height: number
}

/** 主题下发消息类型（父→子）：与注入脚本逐字一致（冻结） */
export const CIKI_EMBED_THEME_MESSAGE_TYPE = "ciki-embed-theme" as const

export interface CikiEmbedThemeMessage {
  type: typeof CIKI_EMBED_THEME_MESSAGE_TYPE
  mode: "light" | "dark"
  style: ThemeStyle
}
