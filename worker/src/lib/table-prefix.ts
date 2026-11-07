/**
 * 表前缀 TABLE_PREFIX 的**唯一解析点**（规格 §7）。
 *
 * 三态语义（GitHub Variables 无法区分"未设置"与"留空"，故 CI 侧用保留字 none）：
 * - 未设置（undefined / null）→ 项目默认前缀，规范化为 "ciki_"
 * - 非空自定义值            → 按现行规范化补尾部 "_"（已带则原样）
 * - 显式空字符串 ""         → 完全不带前缀（表名就是 pages、users …）
 *
 * 约束：生效前缀必须在初始化数据库之前确定，之后不可改——表名按前缀拼出，
 * 中途换前缀等于换一套空表（setup 侧的 409 前缀冲突守卫属于后端单）。除本文件
 * 的 DEFAULT_TABLE_PREFIX 外，代码里不得写死任何部署前缀或最终表名。
 *
 * CI 侧对应实现：scripts/resolve-table-prefix.mjs（只负责把 GitHub Variables
 * 翻成注入值，补尾下划线留在这里做）。两份实现的等价性由
 * worker/test/ci-table-prefix.test.ts 锁住，改一处必须同时改另一处。
 */

/** 未配置 TABLE_PREFIX 时使用的默认前缀（不含尾部下划线）。 */
export const DEFAULT_TABLE_PREFIX = "ciki"

/** 给非空前缀补上尾部下划线（已带则原样返回）。 */
export function ensureTrailingUnderscore(value: string): string {
  return value.endsWith("_") ? value : `${value}_`
}

/** 把 env.TABLE_PREFIX 解析成可直接拼表名的生效前缀。 */
export function getTablePrefix(env: { TABLE_PREFIX?: string | null }): string {
  const raw = env.TABLE_PREFIX
  // 态 1：未配置 → 默认前缀
  if (raw === undefined || raw === null) {
    return ensureTrailingUnderscore(DEFAULT_TABLE_PREFIX)
  }
  // 态 3：显式置空 → 无前缀
  if (raw === "") {
    return ""
  }
  // 态 2：自定义值 → 规范化后原样使用
  return ensureTrailingUnderscore(raw)
}

/**
 * 生效前缀是否可安全拼进 SQL 标识符：空串（无前缀）合法；非空时必须以字母或
 * 下划线开头，其后只允许字母、数字、下划线——`2026_pages`、`1abc_pages` 都不是
 * 合法 SQL 标识符。非法配置一律 fail closed（见 src/index.ts 的中间件），
 * 绝不放行成畸形表名。
 */
export function isValidTablePrefix(prefix: string): boolean {
  return prefix === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)
}
