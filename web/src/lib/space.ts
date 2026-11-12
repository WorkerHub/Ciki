import type { Space, SpaceRole } from "@/lib/api"

/**
 * 空间角色的纯函数口径（与后端冻结契约一致）：
 * - 站点管理员对所有空间的有效角色视为 `admin`；
 * - `editor` 及以上可写页面，`admin` 才能改空间信息 / 成员 / 删空间。
 * 角色未知（列表未到、空间不在列表）一律当作「不可写」处理，写入口不渲染。
 * 角色名是界面文案，统一走 locale 的 `common.roles.*`，这里不放中文。
 */

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

/** 可作为跨空间移动目标的候选：自己可编辑、且不是当前所在的空间。 */
export function editableSpaces(
  spaces: Space[],
  isSiteAdmin: boolean,
  exceptId?: number | null
): Space[] {
  return spaces.filter(
    (space) =>
      space.id !== exceptId && canEdit(effectiveRole(space, isSiteAdmin))
  )
}

/** 路由里的 slug → 空间；列表未到时返回 null（调用方据此给骨架/404）。 */
export function spaceBySlug(spaces: Space[], slug: string): Space | null {
  if (!slug) return null
  return spaces.find((space) => space.slug === slug) ?? null
}
