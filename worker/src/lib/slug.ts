/**
 * 空间 slug（规格「空间整数主键 + slug 唯一列，URL `/s/<slug>/…`」）。
 *
 * 口径定版：由空间名生成——小写、非字母数字转连字符、裁剪；空或撞名兜底
 * `space-<id>` 保唯一；**创建后不随改名自动变**（改 URL 会让既有书签失效）。
 *
 * 纯函数：撞名判定在 `db/queries/spaces.ts`（要查库），这里只负责「名字 → 候选 slug」。
 */

/** slug 长度上限：够表达、又不至于把 URL 拉得太长。 */
export const MAX_SPACE_SLUG_LENGTH = 48

/**
 * 空间名 → slug 候选（可能为空串，表示名字里没有任何可用字符）。
 *
 * 中文等非 ASCII 字符一律按「非字母数字」转连字符，所以「默认空间」的候选是空串，
 * 由调用方回落到 `space-<id>`。
 */
export function spaceSlugCandidate(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug.length <= MAX_SPACE_SLUG_LENGTH) return slug
  return slug.slice(0, MAX_SPACE_SLUG_LENGTH).replace(/-+$/g, "")
}

/** 空候选或候选已被占用时的兜底形态（`space-<id>`，id 让唯一性由主键保证）。 */
export function spaceSlugFallback(id: number): string {
  return `space-${id}`
}

/**
 * 定稿 slug：候选可用就用候选，否则回落 `space-<id>`。
 *
 * `taken` 让调用方传入「是否已被别的空间占用」（创建时查一次、迁移时用内存集合）。
 */
export function spaceSlug(name: string, id: number, taken: boolean): string {
  if (taken) return spaceSlugFallback(id)
  const candidate = spaceSlugCandidate(name)
  return candidate === "" ? spaceSlugFallback(id) : candidate
}

/**
 * 保证唯一的定稿 slug：先按 {@link spaceSlug} 取，仍撞名就追加 `-2`、`-3`…
 *
 * 兜底形态 `space-<id>` 也可能撞名——有人把空间真的叫「space-7」，而后来的第 7 个
 * 空间兜底也是 `space-7`。唯一索引会拒掉那种行，所以发号时自己收敛到唯一值。
 */
export function uniqueSpaceSlug(
  name: string,
  id: number,
  isTaken: (slug: string) => boolean
): string {
  const candidate = spaceSlugCandidate(name)
  const base =
    candidate !== "" && !isTaken(candidate) ? candidate : spaceSlugFallback(id)
  if (!isTaken(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const next = `${base}-${suffix}`
    if (!isTaken(next)) return next
  }
}
