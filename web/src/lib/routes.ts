/**
 * 路由与链接的唯一出口（ID 整数化后）：
 * - 页面地址一律是全局的 `/p/<整数 id>`，空间上下文的入口是 `/s/<slug>/…`；
 * - 组件里不拼模板串，改路由形态只改这一个文件；
 * - 旧 UUID 地址不保留：`parseIdParam` 只认纯十进制正整数，其余一律视为「不存在」。
 */

/** 数字 id 的路径段：只接受 `1..Number.MAX_SAFE_INTEGER` 的十进制写法。 */
export function parseIdParam(raw: string | undefined | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 页面阅读地址 `/p/<id>`。 */
export function pagePath(id: number): string {
  return `/p/${id}`
}

/** 页面编辑地址 `/p/<id>/edit`。 */
export function pageEditPath(id: number): string {
  return `/p/${id}/edit`
}

/** 空间首页（页面树根）`/s/<slug>`。 */
export function spacePath(slug: string): string {
  return `/s/${encodeURIComponent(slug)}`
}

/** 空间回收站 `/s/<slug>/trash`。 */
export function spaceTrashPath(slug: string): string {
  return `${spacePath(slug)}/trash`
}

/** 空间搜索 `/s/<slug>/search`（可带 `?q=`）。 */
export function spaceSearchPath(slug: string, query?: string): string {
  const base = `${spacePath(slug)}/search`
  const trimmed = (query ?? "").trim()
  return trimmed ? `${base}?q=${encodeURIComponent(trimmed)}` : base
}

/** 空间设置 `/s/<slug>/settings`。 */
export function spaceSettingsPath(slug: string): string {
  return `${spacePath(slug)}/settings`
}
