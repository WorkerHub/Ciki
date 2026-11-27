import type { Space, SpaceRole } from "@/lib/api"

/**
 * 空间角色的纯函数口径（与后端冻结契约一致）：
 * - 站点管理员对所有空间的有效角色视为 `admin`；
 * - `editor` 及以上可写页面，`admin` 才能改空间信息 / 成员 / 删空间。
 * 角色未知（列表未到、空间不在列表）一律当作「不可写」处理，写入口不渲染。
 * 角色名是界面文案，统一走 locale 的 `common.roles.*`，这里不放中文。
 */

/** 空间 slug 长度上限（与后端 worker/src/lib/slug.ts 一致）。 */
export const MAX_SPACE_SLUG_LENGTH = 48

/**
 * 空间 slug 格式（与后端 worker/src/lib/slug.ts 一致）：
 * 1–48 位，只许小写字母、数字、单连字符分段，首尾不得为连字符、不许连续连字符。
 */
export const SPACE_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 判断空间 slug 是否合法（格式 + 长度）。 */
export function isValidSpaceSlug(slug: string): boolean {
  return (
    slug.length >= 1 &&
    slug.length <= MAX_SPACE_SLUG_LENGTH &&
    SPACE_SLUG_PATTERN.test(slug)
  )
}

/**
 * 空间名 → slug 候选（可能为空串，表示名字里没有任何可用字符）。
 *
 * 规则（与后端 worker/src/lib/slug.ts 一致）：小写、非字母数字转连字符、裁剪首尾连字符；
 * 上限 48 位截断并去尾连字符。纯中文等非 ASCII 返回空串。
 */
export function spaceSlugCandidate(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug.length <= MAX_SPACE_SLUG_LENGTH) return slug
  return slug.slice(0, MAX_SPACE_SLUG_LENGTH).replace(/-+$/g, "")
}

export function effectiveRole(space: Space, isSiteAdmin: boolean): SpaceRole {
  return isSiteAdmin ? "admin" : space.myRole
}

export function roleForSpace(
  spaces: Space[],
  spaceId: number | null | undefined,
  isSiteAdmin: boolean
): SpaceRole | null {
  if (!spaceId) return null
  const space = spaces.find((item) => item.id === spaceId)
  return space ? effectiveRole(space, isSiteAdmin) : null
}

export function canEdit(role: SpaceRole | null | undefined): boolean {
  return role === "admin" || role === "editor"
}

export function canManage(role: SpaceRole | null | undefined): boolean {
  return role === "admin"
}

/**
 * 进入应用时决定当前空间：优先本机记住的 id，失效（被删 / 已不是成员）时
 * 回落默认空间，再回落列表第一个；一个空间都没有时返回 null。
 */
export function pickInitialSpace(
  spaces: Space[],
  preferredId: number | null | undefined
): Space | null {
  if (preferredId) {
    const preferred = spaces.find((space) => space.id === preferredId)
    if (preferred) return preferred
  }
  return spaces.find((space) => space.isDefault) ?? spaces[0] ?? null
}

/** 可作为移动目标的候选：自己可编辑的全部空间（含页面当前所在空间，同空间改父页也走它）。 */
export function editableSpaces(spaces: Space[], isSiteAdmin: boolean): Space[] {
  return spaces.filter((space) => canEdit(effectiveRole(space, isSiteAdmin)))
}

/** 路由里的 slug → 空间；列表未到时返回 null（调用方据此给骨架/404）。 */
export function spaceBySlug(spaces: Space[], slug: string): Space | null {
  if (!slug) return null
  return spaces.find((space) => space.slug === slug) ?? null
}
