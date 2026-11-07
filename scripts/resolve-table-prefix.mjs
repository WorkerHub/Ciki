/**
 * CI 侧 TABLE_PREFIX 三态解析（唯一实现，供 scripts/materialize-secrets.mjs 使用）。
 *
 * 运行时解析在 worker/src/lib/table-prefix.ts 的 getTablePrefix()：它把非空值
 * 规范化成"补尾下划线"。这里刻意只做"把 GitHub Variables 的原始值翻成要注入
 * wrangler [vars] 的值"，补尾下划线留给运行时——两处各补一次只会让语义更难对。
 *
 * 三态（GitHub Variables 里"未设置"与"留空"不可区分，故用保留字 none 表达置空）：
 * - 未设置 / 空串 → 项目默认前缀 "ciki"（运行时规范化为 "ciki_"）
 * - 保留字 "none"  → ""（显式无前缀）
 * - 其他值        → 原样注入
 *
 * 两份实现的等价性由 worker/test/ci-table-prefix.test.ts 锁住。
 */

/** 项目默认前缀（不含尾部下划线，与 worker 侧常量同值）。 */
export const DEFAULT_TABLE_PREFIX = "ciki"

/** 表达"显式无前缀"的保留字。 */
export const NO_PREFIX_KEYWORD = "none"

/**
 * 把 GitHub Variables 的 TABLE_PREFIX 原始值翻成注入值。
 * 未设置（undefined/null）与空串等价；none 表示不要前缀。
 */
export function resolveForCi(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_TABLE_PREFIX
  }
  if (raw === NO_PREFIX_KEYWORD) {
    return ""
  }
  return raw
}

/**
 * 前缀是否可用于建表：空串合法（表示无前缀）；非空时必须以字母或下划线开头，
 * 其后只允许字母、数字、下划线——`2026`、`1abc` 这类虽然字符合法，却不是合法 SQL
 * 标识符，拼进表名会直接语法错误。与运行时 isValidTablePrefix() 同一条规则；
 * CI 在写配置前先拦下来，免得把畸形前缀部署上线才在运行时 500。
 */
export function isUsablePrefix(value) {
  return value === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}
