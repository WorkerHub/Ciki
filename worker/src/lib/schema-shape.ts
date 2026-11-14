/**
 * 基线形态校验：迁移 `schema_v1` 的升级闸，只读、不动任何数据与账本。
 *
 * 只接受一种存量来源——当前生产形态（最终令牌形态，即坍缩前的 `schema_v3`）：
 * 整数主键、正文在 R2、`users` 的 base_currency/timezone/theme 已删、
 * `users.username` 的唯一部分索引在位、`email_codes` 的 CHECK 已含
 * `register_verify`、令牌三表（`api_tokens` / 按 `token_id` 的
 * `token_space_scopes` / 多行 `import_tokens`）在位且逐列核对。不符就抛
 * {@link MigrationRejectedError}，由 setup 转成 409 原样回显给管理员——错误信息
 * 自带下一步（先用上一版升到 schema_v3），不猜测式修复、不部分执行。
 *
 * 判据一律读系统表（`sqlite_master` / `PRAGMA table_info` / `PRAGMA index_list`），
 * **不比 DDL 文本**：存量库是旧版用「临时表 + 改名」建出来的，`sqlite_master.sql`
 * 与今天的 DDL 文本不保证逐字一致，比文本会误伤真实生产库。
 */
import {
  SCHEMA_INDEXES,
  SCHEMA_TABLES,
  USERS_USERNAME_UNIQUE_INDEX,
  tableDdl
} from "./schema"
import { tableName, usersTable } from "./tables"

/** 迁移名（本模块只认识基线这一条）。 */
const BASELINE_NAME = "schema_v1"

/**
 * 升级源不被接受（形态不对 / 账本停在中间版本）：属可预期的操作错误，setup 转成
 * 409 并把信息原样交给管理员——迁移本身一字未动。
 */
export class MigrationRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MigrationRejectedError"
  }
}

/**
 * 形态不符的一项：
 * - `missing`：表或索引不存在（全新库、上一次安装中断都长这样，可由建表语句补齐）；
 * - `shape`：结构对不上（旧形态的列、非整数主键、索引不是唯一部分索引…），不能靠
 *   `CREATE … IF NOT EXISTS` 修好，必须拒绝。
 */
export interface BaselineMismatch {
  kind: "missing" | "shape"
  message: string
}

export async function tableExists(
  db: D1Database,
  name: string
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .bind(name)
    .first<{ name: string }>()
  return row !== null
}

async function listTables(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all<{ name: string }>()
  return new Set(rows.results.map((row) => row.name))
}

interface ColumnInfo {
  name: string
  type: string
  pk: number
}

async function columnsOf(db: D1Database, table: string): Promise<ColumnInfo[]> {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<ColumnInfo>()
  return rows.results
}

interface IndexInfo {
  name: string
  unique: number
  partial: number
}

async function indexListOf(
  db: D1Database,
  table: string
): Promise<IndexInfo[]> {
  const rows = await db.prepare(`PRAGMA index_list(${table})`).all<IndexInfo>()
  return rows.results
}

/** 索引 DDL 里的索引名（`{prefix}` 原样保留）；DDL 出自 schema.ts，形状固定。 */
function indexIdentifier(ddl: string): string {
  const match = /INDEX\s+IF\s+NOT\s+EXISTS\s+(\S+)/i.exec(ddl)
  if (!match) throw new Error(`schema index DDL has no index name: ${ddl}`)
  return match[1]
}

/** 定版结构里三列已删的旧形态特征（v6 及以前）。 */
const RETIRED_USER_COLUMNS = ["base_currency", "timezone", "theme"]

/**
 * 令牌三表的最终形态全列（含主键），与 `schema.ts` 的冻结 DDL 逐字对应。
 * `token_space_scopes` 是复合主键、没有自增 `id`，它的两个列都在这里。
 */
const TOKEN_TABLE_COLUMNS: Record<string, string[]> = {
  api_tokens: [
    "id",
    "user_id",
    "kind",
    "name",
    "token_hash",
    "created_at",
    "last_used_at",
    "revoked_at"
  ],
  import_tokens: [
    "id",
    "user_id",
    "name",
    "token_hash",
    "created_at",
    "last_used_at",
    "revoked_at"
  ],
  token_space_scopes: ["token_id", "space_id"]
}

/** 定版 `users` 必须有、旧形态没有的列。 */
const REQUIRED_USER_COLUMNS = [
  "email_verified",
  "language",
  "username",
  "avatar_key"
]

/**
 * 逐项比对当前库与 `schema.ts` 的定版结构，返回全部不符项（空数组 = 就是基线）。
 *
 * 覆盖面（宁全勿缺）：全部表在位；`users` 三列已删且身份列齐备；`pages` /
 * `page_revisions` 是「正文在 R2」的形态；每个 `INTEGER PRIMARY KEY AUTOINCREMENT`
 * 的 `id` 确为整数主键；令牌三表逐列核对（缺列/多列/改列都拦下），
 * `token_space_scopes` 的复合主键位置也对；`email_codes` 的 CHECK 已含 `register_verify`；
 * `SCHEMA_INDEXES` 里的索引全部在位，`users.username` 那条还必须是「唯一 + 部分索引」。
 */
export async function findBaselineMismatches(
  db: D1Database,
  prefix: string
): Promise<BaselineMismatch[]> {
  const problems: BaselineMismatch[] = []
  const tables = await listTables(db)

  const columnsIfPresent = async (
    logical: string
  ): Promise<string[] | null> => {
    const name = tableName(prefix, logical)
    if (!tables.has(name)) return null
    return (await columnsOf(db, name)).map((column) => column.name)
  }

  for (const table of SCHEMA_TABLES) {
    const name = tableName(prefix, table.name)
    if (!tables.has(name)) {
      problems.push({ kind: "missing", message: `table ${name} is missing` })
    }
  }

  const users = await columnsIfPresent("users")
  if (users) {
    for (const column of RETIRED_USER_COLUMNS) {
      if (users.includes(column)) {
        problems.push({
          kind: "shape",
          message: `${usersTable(prefix)} still has the pre-collapse column ${column}`
        })
      }
    }
    for (const column of REQUIRED_USER_COLUMNS) {
      if (!users.includes(column)) {
        problems.push({
          kind: "shape",
          message: `${usersTable(prefix)} is missing column ${column}`
        })
      }
    }
  }

  const pages = await columnsIfPresent("pages")
  if (pages) {
    for (const column of ["content_hash", "space_id"]) {
      if (!pages.includes(column)) {
        problems.push({
          kind: "shape",
          message: `${tableName(prefix, "pages")} is missing column ${column}`
        })
      }
    }
    if (pages.includes("content_json")) {
      problems.push({
        kind: "shape",
        message: `${tableName(prefix, "pages")} still stores content_json in D1`
      })
    }
  }

  const revisions = await columnsIfPresent("page_revisions")
  if (revisions) {
    for (const column of ["content_hash", "version_no"]) {
      if (!revisions.includes(column)) {
        problems.push({
          kind: "shape",
          message: `${tableName(prefix, "page_revisions")} is missing column ${column}`
        })
      }
    }
  }

  // 整数主键：哪些表是 `id INTEGER PRIMARY KEY AUTOINCREMENT` 由 DDL 自己说了算，
  // 不手抄表名（新增表也不会漏检）。
  for (const table of SCHEMA_TABLES) {
    if (
      !/\bid\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(
        tableDdl(table.name)
      )
    ) {
      continue
    }
    const name = tableName(prefix, table.name)
    if (!tables.has(name)) continue
    const id = (await columnsOf(db, name)).find(
      (column) => column.name === "id"
    )
    const isIntegerKey =
      id !== undefined && id.type.toUpperCase() === "INTEGER" && id.pk === 1
    if (!isIntegerKey) {
      problems.push({
        kind: "shape",
        message: `${name}.id is not an INTEGER PRIMARY KEY`
      })
    }
  }

  // 令牌三表逐列核对：缺列、多列、改列都会被拦下；表不存在则跳过（前面已报）。
  for (const [logical, expected] of Object.entries(TOKEN_TABLE_COLUMNS)) {
    const name = tableName(prefix, logical)
    if (!tables.has(name)) continue
    const actual = new Set(
      (await columnsOf(db, name)).map((column) => column.name)
    )
    for (const column of expected) {
      if (!actual.has(column)) {
        problems.push({
          kind: "shape",
          message: `${name} is missing column ${column}`
        })
      }
    }
    for (const column of actual) {
      if (!expected.includes(column)) {
        problems.push({
          kind: "shape",
          message: `${name} has unexpected column ${column}`
        })
      }
    }
  }

  // `token_space_scopes` 没有自增 `id`，通用整数主键循环不碰它：它的结构就体现在
  // 复合主键 (token_id, space_id) 上，逐列核对之外还要确认这两列确实是主键。
  const scopes = tableName(prefix, "token_space_scopes")
  if (tables.has(scopes)) {
    const pkOf = new Map(
      (await columnsOf(db, scopes)).map((column) => [column.name, column.pk])
    )
    if (pkOf.get("token_id") !== 1 || pkOf.get("space_id") !== 2) {
      problems.push({
        kind: "shape",
        message: `${scopes} is not keyed on (token_id, space_id)`
      })
    }
  }

  // `email_codes` 的 purpose CHECK 是否已经收下 register_verify（v6 形态没有）。
  const emailCodes = tableName(prefix, "email_codes")
  if (tables.has(emailCodes)) {
    const row = await db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
      .bind(emailCodes)
      .first<{ sql: string | null }>()
    if (!(row?.sql ?? "").includes("register_verify")) {
      problems.push({
        kind: "shape",
        message: `${emailCodes} still has the pre-collapse purpose CHECK (no register_verify)`
      })
    }
  }

  const present = new Set(
    (
      await db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
        .all<{ name: string }>()
    ).results.map((row) => row.name)
  )
  const usernameIndex = indexIdentifier(USERS_USERNAME_UNIQUE_INDEX).replaceAll(
    "{prefix}",
    prefix
  )
  for (const ddl of SCHEMA_INDEXES) {
    const identifier = indexIdentifier(ddl)
    const name = identifier.replaceAll("{prefix}", prefix)
    if (!present.has(name)) {
      problems.push({ kind: "missing", message: `index ${name} is missing` })
    }
  }

  // 同名普通索引不算数：唯一性由「唯一 + 部分索引」表达（空串不参与）。
  const usersName = usersTable(prefix)
  if (tables.has(usersName)) {
    const entry = (await indexListOf(db, usersName)).find(
      (row) => row.name === usernameIndex
    )
    if (entry && (entry.unique !== 1 || entry.partial !== 1)) {
      problems.push({
        kind: "shape",
        message: `index ${usernameIndex} is not the unique partial username index`
      })
    }
  }

  return problems
}

/** 组装拒绝信息：前 3 项 + 分情形的下一步 + 明确「什么都没改」。 */
export function rejection(details: string[]): MigrationRejectedError {
  const shown = details.slice(0, 3).join("; ")
  const rest =
    details.length > 3 ? ` (and ${details.length - 3} more problem(s))` : ""
  return new MigrationRejectedError(
    `Unsupported database shape for ${BASELINE_NAME}: ${shown}${rest}. ` +
      `This version only upgrades a database that is already at schema_v3. ` +
      `If the ledger does not record schema_v3 yet, upgrade this database to schema_v3 with the previous release ` +
      `(the one that supports the v2 → v3 step) and then run this upgrade again. ` +
      `If the ledger already records schema_v3, the structure was altered after the fact: ` +
      `restore this database from the Time Travel bookmark taken before the upgrade ` +
      `(wrangler d1 time-travel restore <db> --bookmark=<bookmark>), or repair the items above first. ` +
      `Nothing was changed.`
  )
}
