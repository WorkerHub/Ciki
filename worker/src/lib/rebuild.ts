/**
 * 存量库的一次性全表重建（迁移 `schema_v7` 的 prepare 阶段）。
 *
 * 唯一支持的升级源 = 当前生产形态（`schema_v6` 之后的结构：整数 id、正文在 R2、
 * `users` 仍带 base_currency/timezone/theme、`email_codes` 的 CHECK 还没有
 * `register_verify`）。目标 = `schema.ts` 的定版结构。
 *
 * 顺序（不许调换）：
 * ①判定来源：缺业务表（全新库/半成品）→ 什么都不做，交给同一条迁移的建表语句；
 *   已是定版结构 → 只补索引，幂等空转；v6 形态 → 重建；其余（UUID 时代）→ 抛错中止，
 *   一个表都不动。
 * ②清掉上一次中断留下的 `v7_*` 临时表。
 * ③按定版 DDL 建 `v7_*` 临时表（不带索引，切换后再补，避免索引名冲突）。
 * ④拷数据：`users` 的三列直接丢弃、`email_verified` 一律置 1、其余列逐值保真；
 *   其它表按「定版列 ∩ 旧表列」整表搬（`pages_fts` 显式三列）。
 * ⑤校验闸（任一不过就抛错，不切表、不记账、旧数据完整，修好重跑即可）：
 *   逐表行数相等；`pages` / `page_revisions` 按 id 逐行 `content_hash` 相等；
 *   两表里出现的每个内容对象都能从内容桶取回且哈希吻合（全量，不抽样）。
 * ⑥单次 `db.batch()` 逐表 DROP 旧 + RENAME 临时表，再幂等补索引。
 *
 * 重名消解：索引按 `SCHEMA_INDEXES` 建，其中有 `users.username` 的唯一索引；
 * 带重名的表建不上索引，所以建索引之前必须先消解——重建路径在 **临时表** 上做，
 * 校验不过时旧库连用户名都一字未动；两条幂等空转路径在正式表上做（见对应分支）。
 */
import type { MigrationContext } from "./migrations"
import { hashContent, readContent } from "../core/content-store"
import { resolveDuplicateUsernames } from "../core/username"
import { SCHEMA_INDEXES, SCHEMA_TABLES, tableDdl, withTable } from "./schema"
import { pagesTable, tableName, usersTable } from "./tables"

/** 临时表名前缀：`{prefix}v7_<逻辑表名>`。 */
export const REBUILD_TEMP_PREFIX = "v7_"

/** 带正文指针的两张表：`content_hash` 必须逐行一致，且对象可回读。 */
const CONTENT_TABLES = ["pages", "page_revisions"] as const

function tempName(prefix: string, logical: string): string {
  return tableName(prefix, `${REBUILD_TEMP_PREFIX}${logical}`)
}

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .bind(name)
    .first<{ name: string }>()
  return row !== null
}

/** 表不存在时返回空数组（老库可能只跑过部分迁移）。 */
async function columnNames(db: D1Database, table: string): Promise<string[]> {
  if (!(await tableExists(db, table))) return []
  const rows = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
  return rows.results.map((row) => row.name)
}

async function countOf(db: D1Database, table: string): Promise<number> {
  if (!(await tableExists(db, table))) return 0
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>()
  return row?.count ?? 0
}

/** 按定版建索引（幂等；切换后与「已是定版结构」的空转都走这里）。 */
async function ensureIndexes(db: D1Database, prefix: string): Promise<void> {
  for (const ddl of SCHEMA_INDEXES) {
    await db.prepare(ddl.replaceAll("{prefix}", prefix)).run()
  }
}

async function dropTempTables(db: D1Database, prefix: string): Promise<void> {
  for (const table of SCHEMA_TABLES) {
    await db
      .prepare(`DROP TABLE IF EXISTS ${tempName(prefix, table.name)}`)
      .run()
  }
}

async function createTempTables(db: D1Database, prefix: string): Promise<void> {
  for (const table of SCHEMA_TABLES) {
    await db
      .prepare(withTable(tableDdl(table.name), tempName(prefix, table.name)))
      .run()
  }
}

/**
 * 把旧表整表搬进临时表，返回「每张临时表应该有几行」。
 *
 * 列名取两表交集（按定版列序），所以旧表多出来的列（`users` 的三列）自然被丢掉；
 * `users.email_verified` 不参与拷贝，统一写 1——存量用户都是已知用户，不锁任何人。
 * 旧表不存在就跳过拷贝，期望 0 行。
 */
async function copyTables(
  db: D1Database,
  prefix: string
): Promise<Map<string, number>> {
  const expected = new Map<string, number>()

  for (const table of SCHEMA_TABLES) {
    const logical = table.name
    const target = tempName(prefix, logical)
    const source = tableName(prefix, logical)
    const oldColumns = await columnNames(db, source)
    expected.set(logical, await countOf(db, source))
    if (oldColumns.length === 0) continue

    const finalColumns = await columnNames(db, target)
    const old = new Set(oldColumns)

    if (logical === "pages_fts") {
      await db
        .prepare(
          `INSERT INTO ${target} (page_id, title, content_text)
           SELECT page_id, title, content_text FROM ${source}`
        )
        .run()
      continue
    }

    const copyColumns = finalColumns.filter(
      (column) =>
        old.has(column) && (logical !== "users" || column !== "email_verified")
    )
    const list = copyColumns.join(", ")
    if (logical === "users") {
      await db
        .prepare(
          `INSERT INTO ${target} (${list}, email_verified)
           SELECT ${list}, 1 FROM ${source}`
        )
        .run()
      continue
    }
    await db
      .prepare(`INSERT INTO ${target} (${list}) SELECT ${list} FROM ${source}`)
      .run()
  }

  return expected
}

/** 闸一：逐表行数必须与旧表一致。 */
async function verifyCounts(
  db: D1Database,
  prefix: string,
  expected: Map<string, number>
): Promise<void> {
  for (const [logical, count] of expected) {
    const actual = await countOf(db, tempName(prefix, logical))
    if (actual !== count) {
      throw new Error(
        `Table ${logical} lost rows during migration (expected ${count}, got ${actual}); nothing was changed`
      )
    }
  }
}

/**
 * 闸二 + 闸三：正文指针逐行一致，且每个内容对象都能回读并通过哈希复核。
 *
 * 左侧连接同时抓「多出来的行」和「哈希被改过的行」——只比行数会漏掉 id 错位。
 * 对象复核是全量的（每个 distinct 哈希一次），不抽样：撞到早已丢失/损坏的对象就
 * 中止，把问题显形在升级这一步，而不是留给运行期的读正文请求。
 */
async function verifyContent(ctx: MigrationContext): Promise<void> {
  const { db, prefix, env } = ctx
  for (const logical of CONTENT_TABLES) {
    const source = tableName(prefix, logical)
    const target = tempName(prefix, logical)

    const mismatch = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${source} o
          LEFT JOIN ${target} t ON t.id = o.id
          WHERE t.id IS NULL OR t.content_hash <> o.content_hash`
      )
      .first<{ count: number }>()
    if ((mismatch?.count ?? 0) > 0) {
      throw new Error(
        `Table ${logical} content pointers changed during migration; nothing was changed`
      )
    }

    const hashes = await db
      .prepare(`SELECT DISTINCT content_hash FROM ${source}`)
      .all<{ content_hash: string }>()
    for (const row of hashes.results) {
      const hash = row.content_hash
      let text: string
      try {
        text = await readContent(env, hash)
      } catch {
        throw new Error(
          `Content object ${hash} (${logical}) is missing; nothing was changed`
        )
      }
      if ((await hashContent(text)) !== hash) {
        throw new Error(
          `Content object ${hash} (${logical}) failed verification; nothing was changed`
        )
      }
    }
  }
}

/** 切换：逐表 DROP 旧 + RENAME 临时表（单事务），索引随后幂等补建。 */
async function swapTables(db: D1Database, prefix: string): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const table of SCHEMA_TABLES) {
    const logical = table.name
    statements.push(
      db.prepare(`DROP TABLE IF EXISTS ${tableName(prefix, logical)}`)
    )
    statements.push(
      db.prepare(
        `ALTER TABLE ${tempName(prefix, logical)} RENAME TO ${tableName(prefix, logical)}`
      )
    )
  }
  await db.batch(statements)
}

/** 库是否已是定版结构（判据：users 无 base_currency 且 pages 有 content_hash）。 */
function isFinalStructure(
  userColumns: string[],
  pageColumns: string[]
): boolean {
  return (
    !userColumns.includes("base_currency") &&
    pageColumns.includes("content_hash")
  )
}

/** 库是否是唯一支持的升级源（v6 形态：users 有 base_currency 且 pages 有 content_hash）。 */
function isSupportedSource(
  userColumns: string[],
  pageColumns: string[]
): boolean {
  return (
    userColumns.includes("base_currency") &&
    pageColumns.includes("content_hash")
  )
}

/**
 * 跑完一次重建。任一校验不过就抛错：临时表留着（下次重跑先清），旧表一个都没动，
 * 账本不会记 `schema_v7`。
 */
export async function rebuildSchema(ctx: MigrationContext): Promise<void> {
  const { db, prefix } = ctx
  const users = usersTable(prefix)
  const pages = pagesTable(prefix)

  // 全新库：没有可搬的数据，建表交给同一条迁移的 sql。
  if (!(await tableExists(db, users))) return

  const userColumns = await columnNames(db, users)

  // 半成品库（迁移在 create 阶段中断）：users 已是定版形态、pages 还没有 → 空转，
  // 让 sql 把缺的表补齐。反过来 users 还带 base_currency 却没有 pages，是没法用
  // 「整表重建」自救的残缺现场，明确报错而不是留一个带三列的 users 表。
  if (!(await tableExists(db, pages))) {
    if (userColumns.includes("base_currency")) {
      throw new Error(
        "Unsupported legacy database shape: users is still the pre-collapse shape " +
          "but the pages table is missing, so the rebuild has no complete source. " +
          "Restore the missing table from a backup (or reset a development database). " +
          "Nothing was changed."
      )
    }
    // 半成品库：建表交给同一条迁移的 sql，但它会一并补建唯一索引，先消解重名。
    await resolveDuplicateUsernames(db, users)
    return
  }

  const pageColumns = await columnNames(db, pages)

  if (isFinalStructure(userColumns, pageColumns)) {
    await resolveDuplicateUsernames(db, users)
    await ensureIndexes(db, prefix)
    return
  }
  if (!isSupportedSource(userColumns, pageColumns)) {
    throw new Error(
      "Unsupported legacy database shape: this upgrade only accepts the current " +
        "schema_v6 structure (integer ids + content_hash). Databases from older " +
        "development builds (uuid ids / content_json) have no upgrade path — " +
        "upgrade to schema_v6 with the previous release first, or reset a development " +
        "database. Nothing was changed."
    )
  }

  await dropTempTables(db, prefix)
  await createTempTables(db, prefix)
  const expected = await copyTables(db, prefix)
  // 唯一索引在切表后按 SCHEMA_INDEXES 补建；先在临时表上消解用户名重名，
  // 否则带重名的存量库会在建索引那一步整体中止。
  await resolveDuplicateUsernames(db, tempName(prefix, "users"))

  await verifyCounts(db, prefix, expected)
  await verifyContent(ctx)

  await swapTables(db, prefix)
  await ensureIndexes(db, prefix)
}
