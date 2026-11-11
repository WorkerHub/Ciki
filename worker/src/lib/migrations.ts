/**
 * 数据库结构的唯一真源：一个初始化版本 + 一次破坏性重建，今后的改动只在末尾追加。
 *
 * 规则（本次重构后）：
 * - `schema_v1` 是全新库的唯一初始化迁移：按 `schema.ts` 的这份定版 DDL 一次建出全部
 *   表/索引（ID 整数化 + 正文 `content_hash` 指针 + 内容清理日志 `kind` 列），并播种
 *   默认空间。基线随这次破坏性重构整体更新，`schema_v2`–`v5` 的净效果已并入基线，
 *   因此它们不再出现在迁移列表里（老库的账本行留着，执行器只认当前列表）。
 * - `schema_v6` 是存量库的一次性重建：把 v1–v5 时代的表整体换成同一份新基线结构，
 *   正文搬上 R2。细节见 `rebuild.ts`。已是新结构的库命中幂等空转，只补索引。
 * - 今后的结构变化只在末尾追加 `schema_v7`、`schema_v8`…，已合并的迁移不得改名、
 *   改内容或调序。
 * - 迁移必须可重复执行；`prepare` 抛错则该迁移不记账，下次 setup 从头重跑。
 * - 语句之间用 `;` 分隔，语句内部不得出现 `;`（含字符串字面量）。
 * - 表名/索引名一律经 src/lib/tables.ts / schema.ts 拼装，本文件只写 `{prefix}` 占位。
 */
import type { Env } from "../types"
import { rebuildSchema } from "./rebuild"
import {
  SCHEMA_INDEXES,
  SCHEMA_TABLES,
  baselineStatements,
  tableDdl,
  withTable
} from "./schema"
import { tableName } from "./tables"

/** 迁移执行时能拿到的东西：库、生效前缀、以及 R2/密钥绑定（重建迁移要写内容桶）。 */
export interface MigrationContext {
  db: D1Database
  prefix: string
  env: Env
}

export interface Migration {
  name: string
  sql: string
  /** 在 sql 之前执行的幂等补齐（数据搬运/重建），见文件头注释。 */
  prepare?: (ctx: MigrationContext) => Promise<void>
}

export const DEFAULT_SPACE_NAME = "默认空间"

/**
 * 默认空间的固定 id 与 slug（全新库播种用）。
 * 存量库升级时 id 按 `created_at` 顺序分配，默认空间通常仍是 1；代码只按 `is_default`
 * 判定默认空间，不假设它一定是 1。
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
 * 默认空间的初始化：用固定 id 1 播种（全新库没有任何历史 id，固定值让书签与
 * 迁移后的形态一致）。`slug` 由名称生成——「默认空间」没有可用 ASCII 字符，按兜底
 * 规则就是 `space-1`。
 */
const SEED_DEFAULT_SPACE = `INSERT OR IGNORE INTO {prefix}spaces
  (id, slug, name, description, is_default, created_by, created_at, updated_at)
VALUES (${DEFAULT_SPACE_ID}, '${DEFAULT_SPACE_SLUG}', '${DEFAULT_SPACE_NAME}', '', 1,
  COALESCE((SELECT id FROM {prefix}users WHERE role = 'admin' ORDER BY id LIMIT 1), 0),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

/** 页面归属回填：空/缺失的 `space_id` 落到默认空间（新结构下是 0 表示缺失）。 */
const BACKFILL_PAGE_SPACE = `UPDATE {prefix}pages SET space_id = COALESCE(
  (SELECT id FROM {prefix}spaces WHERE is_default = 1 LIMIT 1), 1)
  WHERE space_id IS NULL OR space_id = 0`

/** 已有用户加入默认空间：站点管理员 `admin`、其余 `editor`。 */
const SEED_SPACE_MEMBERS = `INSERT OR IGNORE INTO {prefix}space_members
  (space_id, user_id, role, created_at)
SELECT COALESCE((SELECT id FROM {prefix}spaces WHERE is_default = 1 LIMIT 1), 1),
       id,
       CASE WHEN role = 'admin' THEN 'admin' ELSE 'editor' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM {prefix}users`

/** `schema_v1` 的完整语句序列（表 + 索引 + 播种），`;` 分隔、原子地交给执行器。 */
function schemaV1(prefix: string): string {
  const statements = baselineStatements(prefix)
  for (const statement of [
    SEED_DEFAULT_SPACE,
    BACKFILL_PAGE_SPACE,
    SEED_SPACE_MEMBERS
  ]) {
    statements.push(statement.replaceAll("{prefix}", prefix))
  }
  return statements.join(";\n\n")
}

/**
 * schema_v6 —— ID 全量整数化 + 正文上 R2 的一次性重建（规格两份定版同一次升级执行）。
 *
 * 全部动作都要读旧正文、调 Worker 的压缩/哈希/加密能力并写 R2，无法用本文件支持的
 * `;` 分隔语句表达，所以写成 prepare-only 迁移：`sql` 留空，整段在 `prepare` 里
 * （见 `rebuild.ts` 的流程与校验闸）。已是新结构的库只补索引，幂等空转。
 */
const SCHEMA_V6: Migration = {
  name: "schema_v6",
  sql: "",
  prepare: (ctx) => rebuildSchema(ctx)
}

export function getMigrations(prefix: string): Migration[] {
  const sqlV1 = schemaV1(prefix)

  // 表名统一由 tables.ts 的 helper 提供；这里断言 schema.ts 与它用的是同一套名字
  // （改一处就会在这里暴露）。
  for (const table of SCHEMA_TABLES) {
    const expected = tableName(prefix, table.name)
    if (!sqlV1.includes(expected)) {
      throw new Error(`migration schema_v1 is missing table ${expected}`)
    }
  }
  for (const ddl of SCHEMA_INDEXES) {
    if (!ddl.includes("{prefix}")) {
      throw new Error("schema index DDL must use the {prefix} placeholder")
    }
  }

  return [{ name: "schema_v1", sql: sqlV1 }, SCHEMA_V6]
}
