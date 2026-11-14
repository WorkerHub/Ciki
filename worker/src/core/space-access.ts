/**
 * 空间角色与权限的唯一判定点（与 db/queries/spaces.ts 的分工：SQL 查事实，
 * 本文件判能力）。
 *
 * - 站点管理员对所有空间的有效角色视为 `admin`（不受成员表限制）。
 * - 页面写权限以空间角色为准：`admin` / `editor` 可写，`viewer` 只读。
 * - 非成员没有角色：路由层对“空间/页面是否存在”一律回 404，不泄露存在性。
 */
import {
  findSpaceById,
  findSpaceMember,
  type SpaceRow
} from "../db/queries/spaces"

export const SPACE_ROLES = ["admin", "editor", "viewer"] as const

export type SpaceRole = (typeof SPACE_ROLES)[number]

export function isSpaceRole(value: unknown): value is SpaceRole {
  return (
    typeof value === "string" &&
    (SPACE_ROLES as readonly string[]).includes(value)
  )
}

/** 页面写权限：editor 及以上。 */
export function canEditPages(role: SpaceRole | null): boolean {
  return role === "admin" || role === "editor"
}

/** 空间设置与成员管理：仅空间 admin。 */
export function isSpaceManager(role: SpaceRole | null): boolean {
  return role === "admin"
}

export const MAX_SPACE_NAME_LENGTH = 64
export const MAX_SPACE_DESCRIPTION_LENGTH = 500

function isControlChar(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

function hasControlChars(value: string, allowNewline: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (allowNewline && char === "\n") continue
    if (isControlChar(code)) return true
  }
  return false
}

/** 名称：trim 后 1–64 码点、不含控制字符；非法返回 null。 */
export function normalizeSpaceName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.trim()
  if (!name) return null
  if ([...name].length > MAX_SPACE_NAME_LENGTH) return null
  if (hasControlChars(name, false)) return null
  return name
}

/** 描述：trim、≤500 码点、只允许换行；CRLF/CR 统一成 LF；非法返回 null。 */
export function normalizeSpaceDescription(value: unknown): string | null {
  if (typeof value !== "string") return null
  const description = value.replace(/\r\n?/g, "\n").trim()
  if ([...description].length > MAX_SPACE_DESCRIPTION_LENGTH) return null
  if (hasControlChars(description, true)) return null
  return description
}

export interface SpaceAccess {
  space: SpaceRow
  role: SpaceRole
}

/** 解析有效角色；空间不存在或用户不是成员时返回 null（路由层按不存在处理）。 */
export async function resolveSpaceAccess(
  db: D1Database,
  prefix: string,
  spaceId: number,
  userId: number,
  siteAdmin: boolean
): Promise<SpaceAccess | null> {
  const space = await findSpaceById(db, prefix, spaceId)
  if (!space) return null
  if (siteAdmin) return { space, role: "admin" }
  const member = await findSpaceMember(db, prefix, spaceId, userId)
  if (!member) return null
  return { space, role: member.role }
}

/** 仅要角色（页面已查出所属空间时用）。 */
export async function resolveSpaceRole(
  db: D1Database,
  prefix: string,
  spaceId: number,
  userId: number,
  siteAdmin: boolean
): Promise<SpaceRole | null> {
  if (siteAdmin) {
    const space = await findSpaceById(db, prefix, spaceId)
    return space ? "admin" : null
  }
  const member = await findSpaceMember(db, prefix, spaceId, userId)
  return member?.role ?? null
}
