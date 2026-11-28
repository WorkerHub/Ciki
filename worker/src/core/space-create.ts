/**
 * 空间创建单一核心例程：落 space 行 → 派生/校验唯一 slug → 绑定创始人 admin 成员。
 *
 * 会话建空间（`POST /api/spaces`）与外部 write 令牌建空间（`POST /api/write/spaces`）
 * 均复用此例程，保证空间归属、成员身份口径与 slug 递增冲突处理完全一致。
 */
import {
  deleteSpaceStatements,
  insertSpace,
  insertSpaceMember,
  isSpaceSlugTaken,
  listSpaceSlugs,
  updateSpaceSlug,
  type SpaceRow
} from "../db/queries/spaces"
import { isSpaceSlugConflict, uniqueSpaceSlug } from "../lib/slug"

export interface CreateSpaceOptions {
  name: string
  description?: string
  slug?: string | null
  userId: number
  now?: string
}

export type CreateSpaceResult =
  | { ok: true; space: SpaceRow }
  | { ok: false; error: "SPACE_SLUG_TAKEN" }

export async function createSpace(
  db: D1Database,
  prefix: string,
  options: CreateSpaceOptions
): Promise<CreateSpaceResult> {
  const customSlug = options.slug ?? null
  if (customSlug !== null) {
    const taken = await isSpaceSlugTaken(db, prefix, customSlug)
    if (taken) {
      return { ok: false, error: "SPACE_SLUG_TAKEN" }
    }
  }

  const now = options.now ?? new Date().toISOString()
  const description = options.description ?? ""

  // 先落行拿自增 id：slug 的兜底形态 `space-<id>` 要等 id 出来才知道。
  const inserted = await db.batch([
    insertSpace(db, prefix, {
      name: options.name,
      description,
      is_default: 0,
      created_by: options.userId,
      created_at: now,
      updated_at: now
    })
  ])
  const id = inserted[0].meta.last_row_id
  let slug: string
  if (customSlug !== null) {
    slug = customSlug
  } else {
    const usedSlugs = new Set(await listSpaceSlugs(db, prefix))
    slug = uniqueSpaceSlug(options.name, id, (candidate) =>
      usedSlugs.has(candidate)
    )
  }

  try {
    await db.batch([
      updateSpaceSlug(db, prefix, id, slug),
      insertSpaceMember(db, prefix, {
        space_id: id,
        user_id: options.userId,
        role: "admin",
        created_at: now
      })
    ])
  } catch (err) {
    if (isSpaceSlugConflict(err)) {
      await db.batch(deleteSpaceStatements(db, prefix, id)).catch(() => {})
      return { ok: false, error: "SPACE_SLUG_TAKEN" }
    }
    throw err
  }

  return {
    ok: true,
    space: {
      id,
      slug,
      name: options.name,
      description,
      is_default: 0,
      created_by: options.userId,
      created_at: now,
      updated_at: now
    }
  }
}
