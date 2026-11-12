/**
 * 数据库结构的唯一真源：基线迁移 `schema_v1`（结构即 `schema.ts` 的定版 DDL）
 * ＋ 之后的追加迁移 `schema_v2`（令牌两张表，纯追加）与 `schema_v3`（令牌存储合并）。
 *
 * - 全新库：`schema_v1` 的 `sql` 按 `schema.ts` 的定版 DDL 一次建出全部基线表/索引
 *   （`users.username` 的唯一索引就在基线里）并播种默认空间（名称按建库语言），
 *   随后 `schema_v2` 补上令牌两张表、`schema_v3` 把它们合并成最终形态；空库上
 *   v3 的搬运是空转，一次 setup 结束即最终结构。
 * - 存量库：唯一支持的升级源是**当前生产形态**（`schema_v8` 形态）。`prepare` 只做
 *   只读校验（见 `schema-shape.ts`），通过后结构与数据一字不动，账本被改写
 *   （`supersedes` 里的旧记录 + 旧同名 `schema_v1` 行原子清掉并写回 `schema_v1`）；
 *   紧接着 `schema_v2` 建令牌两张表、`schema_v3` 把存量令牌搬进最终形态，账本最终
 *   为 `schema_v1` + `schema_v2` + `schema_v3` 三条。
 * - 已在本版本的库（v1+v2+v3）再 setup：全部 skipped。v3 是重建 + 搬数据，不能
 *   用「纯追加」表达：它在单个 `db.batch()` 里完成并做前后计数校验，失败整批回滚。
 * - 其他形态一律拒绝、不改任何数据与账本：账本有 `schema_v7` 没有 `schema_v8`、
 *   结构对不上基线、更早的 v6 及以前形态。错误信息指路：先用上一版（支持 v7→v8
 *   的发布）升到 `schema_v8`，再换本版本升级。
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
import {
  apiTokensTable,
  apiTokensTokenHashIndex,
  importTokensTable,
  importTokensTokenHashIndex,
  migrationsTable,
  readTokensTable,
  tableName,
  tokenSpaceScopesTable,
  usersTable,
  writeTokensTable,
  writeTokensTokenHashIndex
} from "./tables"

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
   * 基线」：增量链时代留下的同名 `schema_v1` 行不代表新基线已经应用。
   */
  isApplied?: (ctx: MigrationContext) => boolean | Promise<boolean>
}

export const BASELINE_MIGRATION_NAME = "schema_v1"

/**
 * 增量链时代的旧账本记录（`schema_v2`–`schema_v8`）：应用 `schema_v1` 时一并清除。
 * `schema_v1` 自己不在列表里——它的旧同名行由执行器在记账时删掉再写。
 *
 * `schema_v2` / `schema_v3` 虽然已经是**现行**迁移，旧账本里的同名行仍是增量链时代
 * 的另一条迁移：不删掉的话它会让执行器把新迁移当成「已应用」而跳过，新表永远不建。
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
 * 已经不再存在、账本里出现即说明账本没收敛的旧记录（`schema_v4`–`schema_v8`）。
 *
 * `schema_v2` / `schema_v3` 不在其中：它们现在是活迁移，账本里的那一行代表对应
 * 结构已建好，不能再要求「账本里一条旧记录都没有」——否则每次 setup 都会把
 * `schema_v1` 判成未应用而重放，连带删掉活迁移的记账行。
 */
export const RETIRED_MIGRATIONS = [
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
 * 旧版 v6→v7 重建用的页面空间回填与成员播种也一并删掉了——全新库上它们本来就是
 * 空转，而升级路径上它们会写数据。
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
 * ①账本守卫：有 `schema_v7` 却没有 `schema_v8` → 拒绝并指路（那条发布支持 v7→v8）；
 *   即使结构看起来已经完整也不猜「其实只差账本」。
 * ②账本一行都没有 = 全新安装，或上一次安装中断在半路：只允许「表/索引还没建」这类
 *   建表语句能补齐的缺口，交给 `sql` 补齐。
 * ③其余（含账本为空但已有旧形态的表：手工删过账本的库）一律要求结构即基线，不符
 *   就拒绝，一个表都不动。
 */
async function prepareBaseline(ctx: MigrationContext): Promise<void> {
  const { db, prefix, applied } = ctx

  if (applied.has("schema_v7") && !applied.has("schema_v8")) {
    throw new MigrationRejectedError(
      "Unsupported upgrade source: the migration ledger has schema_v7 but not schema_v8, " +
        "so this database stopped before the users.username unique index step. " +
        "Upgrade it to schema_v8 with the previous release (the one that supports the v7 → v8 step), " +
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
 * 只看名字不够：增量链时代的账本里本来就有同名 `schema_v1` 行（另一份定义），手工
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
 * `schema_v1` —— 基线结构（定版 DDL + username 唯一索引 + 默认空间种子）。
 * 本条不得改名、改内容或调序；建库语言只影响种子那一行的 name，不构成结构或谓词
 * 变更。后续结构变化一律以新的 `schema_vN` 追加（见下方 `schema_v2`）。
 */
const SCHEMA_V1: Migration = {
  name: BASELINE_MIGRATION_NAME,
  sql: "",
  prepare: prepareBaseline,
  supersedes: SUPERSEDED_LEDGER_RECORDS,
  isApplied: baselineApplied
}

/**
 * `schema_v2` —— 令牌两张新表（规格 §2.1 / §3.1 / §6）：**纯追加**，只
 * `CREATE … IF NOT EXISTS`，不重建、不改动任何现有表与数据，所以存量 v1 库升级
 * ＝只建这两张表，重复执行是幂等空转。
 *
 * - `write_tokens`：读写接口令牌，逐列同 `read_tokens`（`user_id` 主键，每用户一枚），
 *   库里只存 SHA-256；`token_hash` 唯一索引与只读令牌同口径（查找用）。
 * - `token_space_scopes`：`(token_kind, user_id, space_id)` 三列联合主键，一行 =
 *   「该用户的该类令牌可见该空间」；无行 = 不限制。
 *
 * 新表**不写进** `schema.ts` 的 `SCHEMA_TABLES` / `SCHEMA_INDEXES`：那是 `schema_v1`
 * 的基线清单，`schema-shape.ts` 拿它判 v1 是否已应用，加进去会让只有 v1 的存量库
 * 被误判「结构缺失」而整个升级被拒。
 */
const SCHEMA_V2_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${writeTokensTable("{prefix}")} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${writeTokensTokenHashIndex("{prefix}")}
  ON ${writeTokensTable("{prefix}")}(token_hash)`,
  `CREATE TABLE IF NOT EXISTS ${tokenSpaceScopesTable("{prefix}")} (
  token_kind TEXT NOT NULL CHECK (token_kind IN ('read', 'write')),
  user_id    INTEGER NOT NULL,
  space_id   INTEGER NOT NULL,
  PRIMARY KEY (token_kind, user_id, space_id)
)`
]

const SCHEMA_V2: Migration = {
  name: "schema_v2",
  sql: "",
  /**
   * 账本里的行代表 v2 已建好；此外，库已经是 v3 目标形态时也判已应用——账本被重置
   * （例如 v3 提交后记账前中断）时，绝不能再把 v3 已删掉的旧表重新建出来。
   */
  isApplied: async (ctx) =>
    ctx.applied.has("schema_v2") || (await tokenMigrationDataPresent(ctx))
}

/**
 * 表结构里实际有哪些列（迁移形态校验只看系统表，不比 DDL 文本；表不存在返回空）。
 */
async function tableColumns(db: D1Database, table: string): Promise<string[]> {
  const rows = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
  return rows.results.map((column) => column.name)
}

/** 表里的行数（迁移自愈路径判断旧表是否只是被重放建出来的空壳）。 */
async function tableRowCount(db: D1Database, table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>()
  return row?.count ?? 0
}

/**
 * 令牌数据是否已经是 v3 形态：接口令牌已合表、范围按令牌 id、导入令牌多行。
 * 结构是唯一权威——迁移已提交但账本没记上（或账本被改回旧形态）时，靠它判定
 * 「不需要再搬一遍」。
 */
async function tokenMigrationDataPresent(
  ctx: MigrationContext
): Promise<boolean> {
  const { db, prefix } = ctx
  if (!(await tableExists(db, apiTokensTable(prefix)))) return false
  const scopes = await tableColumns(db, tokenSpaceScopesTable(prefix))
  if (!scopes.includes("token_id") || scopes.includes("token_kind")) {
    return false
  }
  const imports = await tableColumns(db, importTokensTable(prefix))
  return imports.includes("id") && imports.includes("name")
}

/**
 * v3 是否已完整落地：数据形态就绪、旧的两张令牌表已删。
 *
 * 注意「数据就绪但旧表还在」的形态是可达的：账本被改回 v1–v8 后重跑时，
 * `schema_v1` 会按冻结的基线把 `read_tokens` 重新建出来（空表），`schema_v2`
 * 也可能重建 `write_tokens`；这时数据早已搬完，只需清掉空壳旧表，不能再搬一遍。
 */
async function tokenMigrationTargetReady(
  ctx: MigrationContext
): Promise<boolean> {
  const { db, prefix } = ctx
  if (!(await tokenMigrationDataPresent(ctx))) return false
  if (await tableExists(db, readTokensTable(prefix))) return false
  if (await tableExists(db, writeTokensTable(prefix))) return false
  return true
}

/**
 * `schema_v3` 的升级闸（只读）：只接受 v2 形态的令牌四表。目标形态已就绪直接放过
 * （自愈路径）；账本说 v3 已应用但形态不对、`api_tokens` 在而新形态不全、或数据已
 * 搬完但旧表里还有行（说明账本与结构都被改过），一律拒绝，由 setup 转 409 并把
 * 指路信息交给管理员——不猜、不动任何数据。
 *
 * 唯一放过的修复态：数据已是 v3 形态、只剩重放基线建出的**空**旧表（账本被改回
 * v1–v8 后的自愈路径），由 `apply` 只清空壳、不再搬数据。
 */
async function prepareSchemaV3(ctx: MigrationContext): Promise<void> {
  const { db, prefix, applied } = ctx
  if (await tokenMigrationTargetReady(ctx)) return

  if (applied.has("schema_v3")) {
    throw new MigrationRejectedError(
      "The migration ledger records schema_v3 but the token tables are not in the schema_v3 shape. " +
        "Restore this database from the Time Travel bookmark taken before the upgrade, or repair the " +
        "token tables by hand, then run setup again. Nothing was changed."
    )
  }

  // 数据已搬完、只剩重放基线建出的空旧表（账本被改回旧形态后的自愈路径）：
  // 旧表里绝不能有数据，否则说明账本与结构都被改过，不能猜。
  if (await tokenMigrationDataPresent(ctx)) {
    const leftovers = [readTokensTable(prefix), writeTokensTable(prefix)]
    const dirty: string[] = []
    for (const table of leftovers) {
      if (
        (await tableExists(db, table)) &&
        (await tableRowCount(db, table)) > 0
      ) {
        dirty.push(table)
      }
    }
    if (dirty.length > 0) {
      throw new MigrationRejectedError(
        `schema_v3 will not drop the legacy token table(s) ${dirty.join(", ")} because they still contain rows ` +
          "while api_tokens is already in place. Setup will not guess which side is authoritative. " +
          "Restore this database from the Time Travel bookmark taken before the upgrade, then run setup again. " +
          "Nothing was changed."
      )
    }
    return
  }

  if (await tableExists(db, apiTokensTable(prefix))) {
    throw new MigrationRejectedError(
      `schema_v3 cannot start: ${apiTokensTable(prefix)} already exists but the token tables are not in the schema_v3 shape. ` +
        "Setup will not guess which side is authoritative. Restore this database from the Time Travel bookmark " +
        "taken before the upgrade, then run setup again. Nothing was changed."
    )
  }

  const required: Array<{ table: string; columns: string[] }> = [
    {
      table: readTokensTable(prefix),
      columns: [
        "user_id",
        "token_hash",
        "created_at",
        "last_used_at",
        "revoked_at"
      ]
    },
    {
      table: writeTokensTable(prefix),
      columns: [
        "user_id",
        "token_hash",
        "created_at",
        "last_used_at",
        "revoked_at"
      ]
    },
    {
      table: tokenSpaceScopesTable(prefix),
      columns: ["token_kind", "user_id", "space_id"]
    },
    {
      table: importTokensTable(prefix),
      columns: [
        "user_id",
        "token_hash",
        "created_at",
        "last_used_at",
        "revoked_at"
      ]
    }
  ]

  const problems: string[] = []
  for (const item of required) {
    if (!(await tableExists(db, item.table))) {
      problems.push(`table ${item.table} is missing`)
      continue
    }
    const columns = await tableColumns(db, item.table)
    for (const column of item.columns) {
      if (!columns.includes(column)) {
        problems.push(`${item.table} is missing column ${column}`)
      }
    }
  }
  if (problems.length === 0) return

  const shown = problems.slice(0, 3).join("; ")
  const rest =
    problems.length > 3 ? ` (and ${problems.length - 3} more problem(s))` : ""
  throw new MigrationRejectedError(
    `Unsupported token-table shape for schema_v3: ${shown}${rest}. ` +
      "This version upgrades the token tables written by schema_v2 " +
      "(read_tokens / write_tokens / token_space_scopes / import_tokens). " +
      "Restore this database from the Time Travel bookmark taken before the upgrade, " +
      "then run setup again. Nothing was changed."
  )
}

/**
 * `schema_v3` 的全部语句（单次 `db.batch()` 的原子内容）。
 *
 * 顺序固定：建新表 → 搬数据 → 计数守卫 → 删旧表 → 改名 → 重建导入令牌唯一索引。
 * 守卫表用 `CHECK (id = 0)`：四组前后计数只要有一组不等就插一行 1，整批
 * （D1 的 batch 是事务）回滚，不会出现「搬到一半、旧表已删」。
 */
function schemaV3Statements(prefix: string): string[] {
  const api = apiTokensTable(prefix)
  const scopes = tokenSpaceScopesTable(prefix)
  const scopesTemp = tableName(prefix, "v3_token_space_scopes")
  const imports = importTokensTable(prefix)
  const importsTemp = tableName(prefix, "v3_import_tokens")
  const guard = tableName(prefix, "v3_token_migration_guard")

  return [
    `CREATE TABLE IF NOT EXISTS ${api} (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('read', 'write')),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${apiTokensTokenHashIndex(prefix)}
  ON ${api}(token_hash)`,
    `CREATE TABLE IF NOT EXISTS ${scopesTemp} (
  token_id INTEGER NOT NULL,
  space_id INTEGER NOT NULL,
  PRIMARY KEY (token_id, space_id)
)`,
    `CREATE TABLE IF NOT EXISTS ${importsTemp} (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`,
    `INSERT INTO ${api}
  (user_id, kind, name, token_hash, created_at, last_used_at, revoked_at)
SELECT user_id, 'read', '只读 Token', token_hash, created_at, last_used_at, revoked_at
  FROM ${readTokensTable(prefix)}`,
    `INSERT INTO ${api}
  (user_id, kind, name, token_hash, created_at, last_used_at, revoked_at)
SELECT user_id, 'write', '读写 Token', token_hash, created_at, last_used_at, revoked_at
  FROM ${writeTokensTable(prefix)}`,
    `INSERT INTO ${scopesTemp} (token_id, space_id)
SELECT t.id, s.space_id
  FROM ${scopes} s
  JOIN ${api} t ON t.user_id = s.user_id AND t.kind = s.token_kind`,
    `INSERT INTO ${importsTemp}
  (user_id, name, token_hash, created_at, last_used_at, revoked_at)
SELECT user_id, '浏览器插件', token_hash, created_at, last_used_at, revoked_at
  FROM ${imports}`,
    `CREATE TABLE ${guard} (id INTEGER NOT NULL CHECK (id = 0))`,
    `INSERT INTO ${guard} (id) SELECT 1
 WHERE (SELECT COUNT(*) FROM ${readTokensTable(prefix)})
    <> (SELECT COUNT(*) FROM ${api} WHERE kind = 'read')`,
    `INSERT INTO ${guard} (id) SELECT 1
 WHERE (SELECT COUNT(*) FROM ${writeTokensTable(prefix)})
    <> (SELECT COUNT(*) FROM ${api} WHERE kind = 'write')`,
    `INSERT INTO ${guard} (id) SELECT 1
 WHERE (SELECT COUNT(*) FROM ${scopes})
    <> (SELECT COUNT(*) FROM ${scopesTemp})`,
    `INSERT INTO ${guard} (id) SELECT 1
 WHERE (SELECT COUNT(*) FROM ${imports})
    <> (SELECT COUNT(*) FROM ${importsTemp})`,
    `DROP TABLE ${readTokensTable(prefix)}`,
    `DROP TABLE ${writeTokensTable(prefix)}`,
    `DROP TABLE ${scopes}`,
    `DROP TABLE ${imports}`,
    `ALTER TABLE ${scopesTemp} RENAME TO ${scopes}`,
    `ALTER TABLE ${importsTemp} RENAME TO ${imports}`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${importTokensTokenHashIndex(prefix)}
  ON ${imports}(token_hash)`,
    `DROP TABLE ${guard}`
  ]
}

/** 整条 v3 迁移在一个事务里执行；失败即整体回滚，账本不记，下次重跑。 */
async function applySchemaV3(ctx: MigrationContext): Promise<void> {
  if (await tokenMigrationTargetReady(ctx)) return

  // 数据已就绪、只剩重放基线建出的空旧表：只清空壳，不再搬数据。
  if (await tokenMigrationDataPresent(ctx)) {
    const { db, prefix } = ctx
    const drops: D1PreparedStatement[] = []
    for (const table of [readTokensTable(prefix), writeTokensTable(prefix)]) {
      if (!(await tableExists(db, table))) continue
      if ((await tableRowCount(db, table)) > 0) {
        throw new Error(
          `legacy token table ${table} still contains rows; refusing to drop it`
        )
      }
      drops.push(db.prepare(`DROP TABLE ${table}`))
    }
    if (drops.length > 0) await db.batch(drops)
    return
  }

  try {
    await ctx.db.batch(
      schemaV3Statements(ctx.prefix).map((statement) =>
        ctx.db.prepare(statement)
      )
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `schema_v3 token migration was rolled back (${reason}); nothing was changed`,
      { cause: err }
    )
  }
}

/**
 * `schema_v3` —— 令牌存储合并（规格三期 §1 / §2）：
 * `read_tokens` / `write_tokens` 合并为 `api_tokens`（kind 区分），`token_space_scopes`
 * 改为按 `token_id`，`import_tokens` 改为多行；搬到同一个事务里完成并做前后计数
 * 校验，随后删掉旧表。新装与存量（v2 形态）走同一条路径，重复执行是幂等空转。
 *
 * 与 v2 一样**不写进** `schema.ts`：那是基线清单，v1 的形态校验另有「v3 之后忽略
 * read_tokens」的豁免（见 `schema-shape.ts`）。
 */
const SCHEMA_V3: Migration = {
  name: "schema_v3",
  sql: "",
  prepare: prepareSchemaV3,
  apply: applySchemaV3,
  isApplied: tokenMigrationTargetReady
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

  return [
    { ...SCHEMA_V1, sql },
    {
      ...SCHEMA_V2,
      sql: SCHEMA_V2_STATEMENTS.map((statement) =>
        statement.replaceAll("{prefix}", prefix)
      ).join(";\n\n")
    },
    SCHEMA_V3
  ]
}
