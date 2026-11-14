/**
 * 页面移动的唯一实现：站内 `POST /api/pages/:id/move` 与写接口
 * `POST /api/write/pages/:id/move` 走同一份代码。
 *
 * 权限判定留给调用方（两边口径不同：站内越权 403，令牌写接口一律 404，不泄露
 * 存在性）；这里只做与权限无关的结构校验与落库——父页存在/可见/未删/同空间、
 * 禁止移进自身子树（环检测）、目标同级稠密重排、跨空间时整棵后代子树一起改
 * `space_id`，以及旧同级重排。全部语句在同一个 `db.batch()`（D1 的事务单位）里执行。
 *
 * 父页可见性按令牌主人自己的空间角色算，看不见的父页按不存在处理；令牌范围
 * 由写路由在调用前自行叠加（core 不感知令牌）。
 */
import {
  getPageRow,
  listChildren,
  listSubtreeIds,
  updatePagePlacement,
  updatePageSortOrder,
  updateSubtreeSpace,
  type PageRow
} from "../db/queries/pages"
import { resolveSpaceRole } from "./space-access"
import type { Env } from "../types"

/** 结构校验失败的原因；状态码与文案由调用方按各自契约映射。 */
export type PageMoveFailure =
  | "parent_not_found"
  | "parent_not_visible"
  | "parent_deleted"
  | "parent_in_other_space"
  | "page_move_cycle"

export type PageMoveOutcome =
  | { ok: true }
  | { ok: false; error: PageMoveFailure }

export interface PageMoveOptions {
  /** 目标空间（跨空间移动时与 `page.space_id` 不同）。 */
  targetSpaceId: number
  parentId: number | null
  /** 目标同级里的位置（0 起）；`null` = 排到末尾。超出范围时夹到 `[0, n]`。 */
  index: number | null
  now: string
  /** 父页可见性判定：非成员看不见的父页按不存在处理，不泄露它属于哪个空间。 */
  actor: { userId: number; siteAdmin: boolean }
}

export async function applyPageMove(
  env: Env,
  prefix: string,
  page: PageRow,
  options: PageMoveOptions
): Promise<PageMoveOutcome> {
  const db = env.DB
  const { targetSpaceId, parentId, now } = options

  if (parentId !== null) {
    const parentRow = await getPageRow(db, prefix, parentId)
    if (!parentRow) return { ok: false, error: "parent_not_found" }
    const parentRole = await resolveSpaceRole(
      db,
      prefix,
      parentRow.space_id,
      options.actor.userId,
      options.actor.siteAdmin
    )
    if (!parentRole) return { ok: false, error: "parent_not_visible" }
    if (parentRow.deleted_at) {
      return { ok: false, error: "parent_deleted" }
    }
    if (parentRow.space_id !== targetSpaceId) {
      return { ok: false, error: "parent_in_other_space" }
    }
    const subtree = await listSubtreeIds(db, prefix, page.id)
    if (subtree.includes(parentId)) {
      return { ok: false, error: "page_move_cycle" }
    }
  }

  const siblings = (
    await listChildren(db, prefix, targetSpaceId, parentId)
  ).filter((row) => row.id !== page.id)
  const requested = options.index ?? siblings.length
  const index = Math.min(Math.max(requested, 0), siblings.length)
  const ordered = siblings.map((row) => ({ id: row.id, order: row.sort_order }))
  ordered.splice(index, 0, { id: page.id, order: index })

  const statements: D1PreparedStatement[] = []
  // 跨空间移动必须连同整棵后代子树一起改 space_id，否则父子会跨空间。
  if (page.space_id !== targetSpaceId) {
    statements.push(updateSubtreeSpace(db, prefix, page.id, targetSpaceId))
  }
  statements.push(
    updatePagePlacement(
      db,
      prefix,
      page.id,
      targetSpaceId,
      parentId,
      index,
      now
    )
  )
  ordered.forEach((row, order) => {
    if (row.order !== order) {
      statements.push(updatePageSortOrder(db, prefix, row.id, order))
    }
  })
  if (page.parent_id !== parentId || page.space_id !== targetSpaceId) {
    const oldSiblings = await listChildren(
      db,
      prefix,
      page.space_id,
      page.parent_id
    )
    oldSiblings
      .filter((row) => row.id !== page.id)
      .forEach((row, order) => {
        if (row.sort_order !== order) {
          statements.push(updatePageSortOrder(db, prefix, row.id, order))
        }
      })
  }
  await db.batch(statements)

  return { ok: true }
}
