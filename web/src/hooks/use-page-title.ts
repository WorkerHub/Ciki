import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { matchPath, useLocation } from "react-router"
import type { TFunction } from "i18next"
import type { PageNode, Space } from "@/lib/api"
import { parseIdParam } from "@/lib/routes"
import { spaceBySlug } from "@/lib/space"
import { findNode } from "@/lib/tree"
import { usePagesStore } from "@/stores/pages"
import { useSiteStore } from "@/stores/site"
import { useSpacesStore } from "@/stores/spaces"

/**
 * 静态路由 → 页名 i18n key（站名不参与，站名由外层统一拼在「标题 · 站名」里）。
 * 登录 / 注册 / 初始化的页内标题带站名（`auth.*.title` 是「登录 {{siteName}}」这类），
 * 不适合直接当页签标题，所以页签标题单独走 `pageTitle.*` 的裸文案。
 */
const STATIC_TITLE_KEYS: Record<string, string> = {
  "/": "pageTitle.home",
  "/login": "pageTitle.login",
  "/register": "pageTitle.register",
  "/forgot-password": "auth.forgot.title",
  "/verify-email": "auth.verify.title",
  "/setup": "pageTitle.setup",
  "/profile": "profile.title",
  "/settings": "settings.title",
  "/about": "about.title",
  "/admin": "admin.title",
  "/admin/users": "admin.title",
  "/admin/spaces": "admin.title",
  "/admin/site": "admin.title",
  "/admin/security": "admin.title",
  "/admin/email": "admin.title",
  "/admin/others": "admin.title"
}

/** 从 matchPath 拿到的 slug 段是原始百分号编码，路由里用 encodeURIComponent 存过。 */
function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 把当前路由 + 页面树 + 空间列表折算成「不带站名」的页签标题。
 * 顺序从最具体的匹配（编辑页、空间子页）到最宽泛（空间首页），
 * 都匹配不上时回落 404 页名。
 */
export function resolveTitle(
  pathname: string,
  tree: PageNode[],
  spaces: Space[],
  t: TFunction
): string {
  const pageEdit = matchPath("/p/:pageId/edit", pathname)
  if (pageEdit) {
    const id = parseIdParam(pageEdit.params.pageId)
    if (id === null) return t("notFound.title")
    const node = findNode(tree, id)
    return node ? node.title.trim() || t("page.untitled") : t("notFound.title")
  }

  const pageView = matchPath("/p/:pageId", pathname)
  if (pageView) {
    const id = parseIdParam(pageView.params.pageId)
    if (id === null) return t("notFound.title")
    const node = findNode(tree, id)
    return node ? node.title.trim() || t("page.untitled") : t("notFound.title")
  }

  if (matchPath("/s/:slug/search", pathname)) return t("search.title")
  if (matchPath("/s/:slug/trash", pathname)) return t("trash.title")
  if (matchPath("/s/:slug/settings", pathname))
    return t("shell.spaces.settings")

  const home = matchPath("/s/:slug", pathname)
  if (home) {
    const space = spaceBySlug(spaces, decodeSlug(home.params.slug ?? ""))
    return space?.name?.trim() || t("notFound.title")
  }

  const staticKey = STATIC_TITLE_KEYS[pathname]
  if (staticKey) return t(staticKey)

  return t("notFound.title")
}

/** 「标题 · 站名」，站名尚未从站点设置读到（loaded）时只显示标题。 */
export function formatDocumentTitle(
  title: string,
  siteName: string,
  siteLoaded: boolean
): string {
  return siteLoaded && siteName ? `${title} · ${siteName}` : title
}

/**
 * 全局页签标题：挂在壳层（RootGate）覆盖全部路由，随路由 / 页面树 / 空间 /
 * 语言 / 站点名一起重算。页面改名或保存后重拉树，`tree` 变化即触发同步。
 */
export function usePageTitle(): void {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const siteName = useSiteStore((state) => state.name)
  const siteLoaded = useSiteStore((state) => state.loaded)
  const tree = usePagesStore((state) => state.tree)
  const spaces = useSpacesStore((state) => state.spaces)

  useEffect(() => {
    const title = resolveTitle(pathname, tree, spaces, t)
    document.title = formatDocumentTitle(title, siteName, siteLoaded)
  }, [pathname, tree, spaces, siteName, siteLoaded, t])
}
