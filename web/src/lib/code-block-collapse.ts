/**
 * 代码块折叠的三态判定（规格 §一，契约 `pre[data-collapsed="true"|"false"]`）。
 *
 * 折叠是显示状态：属性只决定阅读页初始是否折叠，正文内容、FTS、版本比对都不受影响。
 * - `true`  → 初始折叠；
 * - `false` → 初始展开（显式表态，压住自动规则）；
 * - 其它（缺省 `null`、脏值）→ 自动规则：代码行数 > 20 行才折叠。
 */

/** 未表态时自动折叠的行数门槛（> 20 折，20 行及以下不折）。 */
export const AUTO_COLLAPSE_LINE_THRESHOLD = 20

/**
 * 代码行数：末尾单个换行不算多一行（TipTap 的代码块常以 `\n` 收尾），
 * 空块记 0 行。只用来喂自动规则，不参与存取。
 */
export function codeLineCount(text: string): number {
  if (!text) return 0
  const body = text.endsWith("\n") ? text.slice(0, -1) : text
  return body === "" ? 0 : body.split("\n").length
}

/** 阅读页初始是否折叠：显式布尔优先，其余走行数自动规则。 */
export function resolveInitialCollapsed(
  collapsed: unknown,
  text: string
): boolean {
  if (collapsed === true) return true
  if (collapsed === false) return false
  return codeLineCount(text) > AUTO_COLLAPSE_LINE_THRESHOLD
}
