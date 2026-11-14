/**
 * 数据库结构的唯一真源：唯一基线迁移 `schema_v1`（结构即 `schema.ts` 的定版 DDL，
 * 含令牌最终形态——`api_tokens` / 按 `token_id` 的 `token_space_scopes` / 多行
 * `import_tokens`，不再有 `read_tokens` / `write_tokens`）。
 *
 * - 全新库：`schema_v1` 的 `sql` 按 `schema.ts` 的定版 DDL 一次建出全部表/索引
 *   （含令牌三表的最终形态、`users.username` 的唯一索引）并播种默认空间（名称按
 *   建库语言）；一次 setup 结束即最终结构，账本只记 `schema_v1` 一条。
 * - 存量库：唯一支持的升级源是**当前生产形态**（最终结构，账本为 v1+v2+v3）。
 *   `prepare` 只做只读校验（见 `schema-shape.ts`），通过后结构与数据一字不动，
 *   账本被改写（`supersedes` 里的旧记录 + 旧同名 `schema_v1` 行原子清掉并写回
 *   `schema_v1`），账本收敛为单条 `schema_v1`。
 * - 已在本版本的库（账本只有 `schema_v1`、结构即最终形态）再 setup：skipped。
 * - 其他形态一律拒绝、不改任何数据与账本：账本有 `schema_v2` 没有 `schema_v3`、
 *   结构对不上最终形态、更早的 v1/v2 及以前形态。错误信息指路：先用上一版
 *   （支持 v2→v3 的发布）升到 `schema_v3`，再换本版本升级。
 *
 * 基线已冻结：`schema_v1` 不得改名、改内容或调序；结构变化只在末尾追加新的
 * `schema_vN`（不把新表写回 `schema.ts` 的基线清单——`schema-shape.ts` 拿那份清单判
 * v1 是否已应用）。迁移必须可重复执行；`prepare` 抛错则该迁移不记账，下次 setup
 * 从头重跑。语句之间用 `;` 分隔，语句内部不得出现 `;`（含字符串字面量）。表名/索引名
 * 一律经 tables.ts / schema.ts 拼装，本文件只写 `{prefix}` 占位。
 */
import type { Env } from "../types"
import { DEFAULT_LANGUAGE, type Language } from "../core/language"
import {
  SCHEMA_INDEXES,
  SCHEMA_TABLES,
  baselineStatements,
  tableDdl,
  withTable
} from "./schema"
import {
  MigrationRejectedError,
  findBaselineMismatches,
  rejection,
  tableExists
} from "./schema-shape"
import { migrationsTable, tableName, usersTable } from "./tables"

/** 迁移执行时能拿到的东西：库、生效前缀、迁移可用的绑定、以及账本快照。 */
export interface MigrationContext {
  db: D1Database
  prefix: string
  env: Env
  /** 账本里已应用的迁移名（执行器在跑之前读一次）。 */
  applied: ReadonlySet<string>
}

export interface Migration {
  name: string
  sql: string
  /** 在 sql 之前执行的只读校验 / 幂等补齐；抛错则该条不记账，下次重跑。 */
  prepare?: (ctx: MigrationContext) => Promise<void>
  /**
   * 需要整条迁移原子执行的场景（重建表、搬数据）：在一个 `db.batch()` 里完成。
   * 有 `apply` 时 `sql` 必须为空，执行器只调 `apply`。
   */
  apply?: (ctx: MigrationContext) => Promise<void>
  /**
   * 本条取代的旧账本记录：应用本条时，这些名字（连同本条自己的旧同名行）与本条
   * 记账放进同一个 `db.batch()` 删除 + 重写，使账本只保留当前的版本标记。
   */
  supersedes?: readonly string[]
  /**
   * 是否已应用（缺省只按账本行判定）。`schema_v1` 额外要求「账本已收敛、结构确是
   * 基线」：坍缩前留下的同名 `schema_v1` 行不代表新基线已经应用。
   */
  isApplied?: (ctx: MigrationContext) => boolean | Promise<boolean>
}

export const BASELINE_MIGRATION_NAME = "schema_v1"

/**
 * 坍缩前留在账本里的旧记录（`schema_v2`–`schema_v8`）：应用 `schema_v1` 时一并清除。
 * `schema_v1` 自己不在列表里——它的旧同名行由执行器在记账时删掉再写。
 *
 * 现在只有 `schema_v1` 一条活迁移：`schema_v2`/`schema_v3` 曾是活迁移，坍缩后它们的
 * 账本行（连同 v4–v8 的增量链旧行）都要清掉，账本才只剩当前一条。
 */
export const SUPERSEDED_LEDGER_RECORDS = [
  "schema_v2",
  "schema_v3",
  "schema_v4",
  "schema_v5",
  "schema_v6",
  "schema_v7",
  "schema_v8"
] as const

/**
 * 已经不再存在、账本里出现即说明账本没收敛的旧记录（`schema_v2`–`schema_v8`）。
 *
 * `schema_v2`/`schema_v3` 在坍缩后也不再是活迁移：账本里出现这两行说明还没收敛到
 * 单条 `schema_v1`，`baselineApplied` 必须判「未应用」让基线重放清账本。
 */
export const RETIRED_MIGRATIONS = [
  "schema_v2",
  "schema_v3",
  "schema_v4",
  "schema_v5",
  "schema_v6",
  "schema_v7",
  "schema_v8"
] as const

/**
 * 默认空间名（规格 §2.10）：按**建库那一刻的语言**播种，中文文案逐字不变。
 * 这是系统在 setup 里写入的产品文案，不是用户内容；只有全新安装会用到它——
 * 存量库与用户改过名的空间永远不被改名（见 `seedDefaultSpace` 的双守卫）。
 */
export const DEFAULT_SPACE_NAMES: Record<Language, string> = {
  zh: "默认空间",
  en: "Default Space"
}

export function defaultSpaceName(language: Language): string {
  return DEFAULT_SPACE_NAMES[language]
}

/**
 * 默认空间的固定 id 与 slug（全新库播种用）。
 * 存量库升级时 id 原样保留，默认空间通常仍是 1；代码只按 `is_default` 判定默认空间，
 * 不假设它一定是 1。
 */
export const DEFAULT_SPACE_ID = 1
export const DEFAULT_SPACE_SLUG = "space-1"

/**
 * `auth_counters` 的建表语句（D1 计数表是限流的唯一权威）。setup 限流器会在迁移
 * 之前用同一份 DDL 先建表，所以这里导出模板、两处共用，避免结构漂移。
 *
 * 占位符沿用 `{prefix}`（`core/counters.ts` 直接 replaceAll），DDL 本体仍来自
 * `schema.ts`，不另抄一份。
 */
export const AUTH_COUNTERS_TABLE_DDL = withTable(
  tableDdl("auth_counters"),
  "{prefix}auth_counters"
)

export const AUTH_COUNTERS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS {prefix}auth_counters_action_account
  ON {prefix}auth_counters(action, account)`

/**
 * 默认空间的播种：只属于**全新安装**。
 *
 * 两条守卫缺一不可：
 * - 账本里一条记录都没有（账本名由 tables.ts 拼）：有账本记录就说明这不是新库，
 *   升级路径只许改账本、不许顺手写数据——即使默认空间已被删空也不补；
 * - `spaces` 为空：上一次安装中断在播种前后时不会重复插入（显式 id 1 会撞主键）。
 *
 * 只有 name 这一个值随建库语言变（`DEFAULT_SPACE_NAMES`）；谓词、id、slug、
 * created_by 与基线冻结时逐字相同。
 */
function seedDefaultSpace(prefix: string, language: Language): string {
  const ledger = migrationsTable(prefix)
  // 文案本身是固定表里的常量；转义只为以后加语言时带引号也安全。
  const name = defaultSpaceName(language).replace(/'/g, "''")
  return `INSERT INTO ${prefix}spaces
  (id, slug, name, description, is_default, created_by, created_at, updated_at)
SELECT ${DEFAULT_SPACE_ID}, '${DEFAULT_SPACE_SLUG}', '${name}', '', 1,
  COALESCE((SELECT id FROM ${prefix}users WHERE role = 'admin' ORDER BY id LIMIT 1), 0),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM ${prefix}spaces)
  AND NOT EXISTS (SELECT 1 FROM ${ledger})`
}

/** `schema_v1` 的完整语句序列（表 + 索引 + 默认空间），`;` 分隔、按顺序执行。 */
function schemaV1(prefix: string, language: Language): string {
  const statements = baselineStatements(prefix)
  statements.push(seedDefaultSpace(prefix, language))
  return statements.join(";\n\n")
}

/**
 * `schema_v1` 的升级闸（只读，见 `schema-shape.ts`）。
 *
 * ①账本守卫：有 `schema_v2` 却没有 `schema_v3` → 拒绝并指路（那条发布支持 v2→v3）；
 *   即使结构看起来已经完整也不猜「其实只差账本」。
 * ②账本一行都没有 = 全新安装，或上一次安装中断在半路：只允许「表/索引还没建」这类
 *   建表语句能补齐的缺口，交给 `sql` 补齐。
 * ③其余（含账本为空但已有旧形态的表：手工删过账本的库）一律要求结构即最终形态，
 *   不符就拒绝，一个表都不动。
 */
async function prepareBaseline(ctx: MigrationContext): Promise<void> {
  const { db, prefix, applied } = ctx

  if (applied.has("schema_v2") && !applied.has("schema_v3")) {
    throw new MigrationRejectedError(
      "Unsupported upgrade source: the migration ledger has schema_v2 but not schema_v3, " +
        "so this database stopped before the token-table merge. " +
        "Upgrade it to schema_v3 with the previous release (the one that supports the v2 → v3 step), " +
        "then run this upgrade again. Nothing was changed."
    )
  }

  const problems = await findBaselineMismatches(db, prefix)
  if (problems.length === 0) return

  // 全新/中断的安装：只有「表或索引还没建」这种可以靠建表语句补齐的项。
  const fillable = problems.every((problem) => problem.kind === "missing")
  if (applied.size === 0 && fillable) return

  throw rejection(problems.map((problem) => problem.message))
}

/**
 * 已应用 = 账本里有 `schema_v1`、旧记录一条不剩、库里有表且结构确为基线。
 *
 * 只看名字不够：坍缩前的账本里本来就有同名 `schema_v1` 行（另一份定义），手工
 * 改过账本的开发库也可能「名字对、结构不对」。结构是唯一权威。
 */
async function baselineApplied(ctx: MigrationContext): Promise<boolean> {
  const { db, prefix, applied } = ctx
  if (!applied.has(BASELINE_MIGRATION_NAME)) return false
  if (RETIRED_MIGRATIONS.some((name) => applied.has(name))) return false
  if (!(await tableExists(db, usersTable(prefix)))) return false
  return (await findBaselineMismatches(db, prefix)).length === 0
}

/**
 * `schema_v1` —— 基线结构（定版 DDL + username 唯一索引 + 默认空间种子 +
 * 令牌最终形态）。本条不得改名、改内容或调序；建库语言只影响种子那一行的 name，
 * 不构成结构或谓词变更。后续结构变化一律以新的 `schema_vN` 追加。
 */
const SCHEMA_V1: Migration = {
  name: BASELINE_MIGRATION_NAME,
  sql: "",
  prepare: prepareBaseline,
  supersedes: SUPERSEDED_LEDGER_RECORDS,
  isApplied: baselineApplied
}

export function getMigrations(
  prefix: string,
  language: Language = DEFAULT_LANGUAGE
): Migration[] {
  const sql = schemaV1(prefix, language)

  // 表名统一由 tables.ts 的 helper 提供；这里断言 schema.ts 与它用的是同一套名字
  // （改一处就会在这里暴露）。
  for (const table of SCHEMA_TABLES) {
    const expected = tableName(prefix, table.name)
    if (!sql.includes(expected)) {
      throw new Error(
        `migration ${BASELINE_MIGRATION_NAME} is missing table ${expected}`
      )
    }
  }
  for (const ddl of SCHEMA_INDEXES) {
    if (!ddl.includes("{prefix}")) {
      throw new Error("schema index DDL must use the {prefix} placeholder")
    }
  }

  return [{ ...SCHEMA_V1, sql }]
}
