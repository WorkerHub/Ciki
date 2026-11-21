/**
 * Web App Manifest 组装（规格第 4 项）：manifest 由 Worker 动态下发，name / short_name
 * 取运行时 site_name（fallback DEFAULT_SITE_NAME = "Ciki"），与 /api/public 对齐。
 *
 * 图标是随仓提交的静态 PNG（scripts/export-pwa-icons.mjs 按 favicon.svg 导出，
 * 见 web/public/icons/），路径走 ASSETS 静态服务。
 */
import { DEFAULT_SITE_NAME } from "../core/identity"

export interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: "any" | "maskable"
}

export interface WebAppManifest {
  id: string
  name: string
  short_name: string
  description: string
  start_url: string
  display: string
  background_color: string
  theme_color: string
  icons: ManifestIcon[]
}

/** 站点默认描述（提取自 web/index.html 的 meta description） */
export const SITE_DESCRIPTION =
  "Ciki —— 为个人与小团队打造的 wiki：空间、树形页面、版本历史、全文检索；部署在 Cloudflare 上，免服务器、免运维。"

/** 静态站点默认主题色，与 web/index.html 内联脚本的亮色字面量一致。 */
export const THEME_COLOR = "#ffffff"

export function buildWebAppManifest(siteName?: string | null): WebAppManifest {
  const name = siteName?.trim() || DEFAULT_SITE_NAME
  return {
    id: "/",
    name,
    short_name: name,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: "/icons/pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/pwa-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/pwa-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  }
}
