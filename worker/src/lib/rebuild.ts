/**
 * 存量库的一次性重建迁移（迁移 `schema_v6`）：ID 全量整数化 + 正文上 R2，同一次升级。
 *
 * 顺序（与规格的行文一致，不许调换）：
 * ①探测库已是新结构 → 幂等空转（只补索引）；没有业务表（全新库）→ 什么都不做。
 * ②清掉上一次中断留下的 `v6_*` 临时表。
 * ③建 id 映射：页面 / 用户 / 空间 / 评论按 `created_at` 正序（同刻按旧 id 兜底），
 *    版本同一口径排全局整数 id，再在页内排 `version_no`。映射只在内存里活着，
 *    切换后即消失——不留任何 id 对照层。
 * ④逐页逐版本读旧正文（版本先解压）→ 改写站内页面链接 → 算哈希 → gzip → 上传到
 *    `ciki-content` 的 `content/<sha256>` → 记下哈希。
 * ⑤按新基线 DDL 建 `v6_*` 临时表，写入映射后的行（只写整数 id 与 `content_hash`，
 *    不搬 JSON / gzip 本体）。
 * ⑥校验闸：任一项不过就抛错 —— 不切表、不记账，旧数据完整，修好重跑。
 * ⑦单次 `db.batch()` 完成切换（逐表 DROP 旧 + RENAME 临时表），再幂等补索引。
 *
 * 失败只留下已上传的内容对象，由月度内容 GC 当孤儿收走（30 天龄后）。
 */
import type { MigrationContext } from "./migrations"
import { hashContent, putContent, readContent } from "../core/content-store"
import { decryptSecret, encryptSecret } from "../core/secret-box"
import { toIndexText } from "./fts"
import { gunzipText } from "./gzip"
import { SCHEMA_INDEXES, SCHEMA_TABLES, tableDdl, withTable } from "./schema"
import { uniqueSpaceSlug } from "./slug"
import { derivePageMarkdown } from "./tiptap-markdown"
import { pagesTable, tableName } from "./tables"

/** 临时表名前缀：`{prefix}v6_<逻辑表名>`。 */
const TEMP_PREFIX = "v6_"

/**
 * 不重建的表：结构与内容都不受本次重构影响（没有 id 变更、不存正文）。
 * 其余表全部按新基线 DDL 重建（旧库里缺的表也会被补建出来）。
 */
const KEPT_TABLES = new Set([
  "auth_counters",
  "system_settings",
  "waker_executions"
])

/** 需要重建的表（顺序即建表与切换顺序）。 */
export const REBUILT_TABLES = SCHEMA_TABLES.map((table) => table.name).filter(
  (name) => !KEPT_TABLES.has(name)
)

/** 随机抽样核对正文的页数（规格：随机 5 页）。 */
const SAMPLED_PAGES = 5

/** 单次 `db.batch()` 的语句上限（与既有迁移的分批思路一致）。 */
const BATCH_SIZE = 40

function tempName(prefix: string, logical: string): string {
  return tableName(prefix, `${TEMP_PREFIX}${logical}`)
}

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .bind(name)
    .first<{ name: string }>()
  return row !== null
}

/** 表不存在时返回空集（老库可能只跑过部分迁移，缺表按「没有行」处理）。 */
async function columnNames(
  db: D1Database,
  table: string
): Promise<Set<string>> {
  if (!(await tableExists(db, table))) return new Set()
  const rows = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
  return new Set(rows.results.map((row) => row.name))
}

/** 表不存在时返回空数组（同上）。 */
async function rowsOf<T>(
  db: D1Database,
  table: string,
  sql: string
): Promise<T[]> {
  if (!(await tableExists(db, table))) return []
  const rows = await db.prepare(sql).all<T>()
  return rows.results
}

/** 库是否已是新结构（判据：`pages.content_hash` 列存在）。 */
async function isNewStructure(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  if (!(await tableExists(db, pagesTable(prefix)))) return false
  return (await columnNames(db, pagesTable(prefix))).has("content_hash")
}

/** 分批执行写入语句（每批一个事务）。 */
async function runBatched(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE))
  }
}

/** 按新基线建索引（幂等；切换后与「已是新结构」的续跑都走这里）。 */
async function ensureIndexes(db: D1Database, prefix: string): Promise<void> {
  for (const ddl of SCHEMA_INDEXES) {
    await db.prepare(ddl.replaceAll("{prefix}", prefix)).run()
  }
}

async function dropTempTables(db: D1Database, prefix: string): Promise<void> {
  for (const name of REBUILT_TABLES) {
    await db.prepare(`DROP TABLE IF EXISTS ${tempName(prefix, name)}`).run()
  }
}

/**
 * 旧正文里的站内页面地址：`/p/<UUID>`（含写成绝对 URL 的形态）。
 * 图片地址 `/api/files/<key>` 不在此列，一律原样保留。
 */
const PAGE_LINK_RE =
  /\/p\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g

/**
 * 改写一段正文里的站内页面链接（纯函数）。映射里没有的目标（指向已彻底删除的页面）
 * 原样保留：它在新路由下同样是 404，不制造假链接。
 */
export function rewritePageLinks(
  text: string,
  pages: Map<string, number>
): string {
  if (!text.includes("/p/")) return text
  return text.replace(PAGE_LINK_RE, (match, uuid: string) => {
    const id = pages.get(uuid) ?? pages.get(uuid.toLowerCase())
    return id === undefined ? match : `/p/${id}`
  })
}

/** 按 `created_at, id` 的正序发号（同刻按旧 id 兜底，确定性）。 */
export function assignIds(orderedIds: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const [index, id] of orderedIds.entries()) {
    map.set(id, index + 1)
  }
  return map
}

/** 每页的版本次序：`version_no` 连续 1..N（纯函数，顺序由调用方给定）。 */
export function assignVersionNos(
  ordered: Array<{ id: string; page_id: string }>
): Map<string, { id: number; versionNo: number }> {
  const map = new Map<string, { id: number; versionNo: number }>()
  const perPage = new Map<string, number>()
  ordered.forEach((row, index) => {
    const versionNo = (perPage.get(row.page_id) ?? 0) + 1
    perPage.set(row.page_id, versionNo)
    map.set(row.id, { id: index + 1, versionNo })
  })
  return map
}

interface IdMaps {
  users: Map<string, number>
  spaces: Map<string, number>
  pages: Map<string, number>
  comments: Map<string, number>
  revisions: Map<string, { id: number; versionNo: number }>
}

/**
 * 发号：页面/用户/空间/评论按 `created_at, id`；版本同一口径排全局整数 id，再在
 * 页内排 `version_no`。回收站里的软删页面一并参与（`deleted_at` 不影响发号）。
 */
async function readIdMaps(db: D1Database, prefix: string): Promise<IdMaps> {
  const idsOf = async (logical: string): Promise<string[]> => {
    const rows = await rowsOf<{ id: string; created_at: string }>(
      db,
      tableName(prefix, logical),
      `SELECT id, created_at FROM ${tableName(prefix, logical)} ORDER BY created_at, id`
    )
    return rows.map((row) => row.id)
  }

  const revisionRows = await rowsOf<{
    id: string
    page_id: string
    created_at: string
  }>(
    db,
    tableName(prefix, "page_revisions"),
    `SELECT id, page_id, created_at FROM ${tableName(prefix, "page_revisions")}
      ORDER BY created_at, id`
  )

  return {
    users: assignIds(await idsOf("users")),
    spaces: assignIds(await idsOf("spaces")),
    pages: assignIds(await idsOf("pages")),
    comments: assignIds(await idsOf("comments")),
    revisions: assignVersionNos(
      revisionRows.map((row) => ({ id: row.id, page_id: row.page_id }))
    )
  }
}

/** 通用 INSERT（列名全部来自代码常量，不含用户输入）。 */
function insertInto(
  db: D1Database,
  table: string,
  row: Record<string, unknown>
): D1PreparedStatement {
  const columns = Object.keys(row)
  const placeholders = columns.map(() => "?").join(", ")
  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
    )
    .bind(...columns.map((column) => row[column]))
}

interface LegacyPage {
  id: string
  space_id: string | null
  parent_id: string | null
  title: string
  sort_order: number
  content_json: string
  content_html: string
  content_text: string
  content_md?: string | null
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface NewPageRow {
  id: number
  space_id: number
  parent_id: number | null
  title: string
  sort_order: number
  content_hash: string
  content_html: string
  content_text: string
  content_md: string
  created_by: number
  updated_by: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface MigratedPage {
  /** 迁移前的原始行（内容未改写），校验闸要用它逐字节比对。 */
  source: LegacyPage
  /** 改写后的正文 JSON（上传到 R2 的那一份）。 */
  json: string
  row: NewPageRow
}

interface LegacyRevision {
  id: string
  page_id: string
  title: string
  content_json: string
  content_gzip?: ArrayBuffer | ArrayBufferView | null
  editor_id: string
  created_at: string
}

interface MigratedRevision {
  json: string
  row: {
    id: number
    page_id: number
    version_no: number
    title: string
    content_hash: string
    editor_id: number
    created_at: string
  }
}

/**
 * 跑完一次重建。任一校验不过就抛错：临时表留着（下次重跑先清），旧表一个都没动，
 * 账本不会记 `schema_v6`。
 */
export async function rebuildSchema(ctx: MigrationContext): Promise<void> {
  const { db, prefix, env } = ctx

  if (await isNewStructure(db, prefix)) {
    await ensureIndexes(db, prefix)
    return
  }
  if (!(await tableExists(db, pagesTable(prefix)))) {
    // 完全没有业务表：`schema_v1` 已经在同一次 setup 里建出新基线，无需搬数据。
    return
  }

  await dropTempTables(db, prefix)
  const maps = await readIdMaps(db, prefix)
  const pages = await buildPages(db, prefix, env, maps)
  const revisions = await buildRevisions(db, prefix, env, maps)
  const { rows, expected } = await buildSimpleTables(db, prefix, env, maps)

  expected.pages = pages.length
  expected.page_revisions = revisions.length
  expected.pages_fts = pages.filter(
    (page) => page.row.deleted_at === null
  ).length

  await createTempTables(db, prefix)
  await fillTempTables(db, prefix, pages, revisions, rows)
  await verifyObjects(env, pages, revisions)
  verifyDerived(pages, maps)
  await verifySampledPages(env, db, prefix, maps)
  verifyParentLinks(pages)
  await verifyCounts(db, prefix, expected, maps)

  await swapTables(db, prefix)
  await ensureIndexes(db, prefix)
}

async function buildPages(
  db: D1Database,
  prefix: string,
  env: MigrationContext["env"],
  maps: IdMaps
): Promise<MigratedPage[]> {
  const table = pagesTable(prefix)
  const columns = await columnNames(db, table)
  const hasMd = columns.has("content_md")
  const rows = await rowsOf<LegacyPage>(
    db,
    table,
    `SELECT id, space_id, parent_id, title, sort_order, content_json,
            content_html, content_text,
            ${hasMd ? "content_md" : "NULL AS content_md"},
            created_by, updated_by, created_at, updated_at, deleted_at
       FROM ${table}
      ORDER BY created_at, id`
  )

  const out: MigratedPage[] = []
  for (const row of rows) {
    const id = maps.pages.get(row.id)
    const spaceId = maps.spaces.get(row.space_id ?? "")
    if (id === undefined || spaceId === undefined) {
      throw new Error(
        `Page ${row.id} cannot be remapped (missing page/space id); nothing was changed`
      )
    }
    const json = rewritePageLinks(row.content_json ?? "", maps.pages)
    const hash = await putContent(env, json)
    const markdown =
      row.content_md ||
      derivePageMarkdown(row.content_json ?? "", row.content_text ?? "")
    out.push({
      source: { ...row, content_md: markdown },
      json,
      row: {
        id,
        space_id: spaceId,
        parent_id: row.parent_id
          ? (maps.pages.get(row.parent_id) ?? null)
          : null,
        title: row.title,
        sort_order: row.sort_order,
        content_hash: hash,
        content_html: rewritePageLinks(row.content_html ?? "", maps.pages),
        content_text: rewritePageLinks(row.content_text ?? "", maps.pages),
        content_md: rewritePageLinks(markdown, maps.pages),
        created_by: maps.users.get(row.created_by) ?? 0,
        updated_by: maps.users.get(row.updated_by) ?? 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at
      }
    })
  }
  return out
}

async function buildRevisions(
  db: D1Database,
  prefix: string,
  env: MigrationContext["env"],
  maps: IdMaps
): Promise<MigratedRevision[]> {
  const table = tableName(prefix, "page_revisions")
  const columns = await columnNames(db, table)
  const hasGzip = columns.has("content_gzip")
  const rows = await rowsOf<LegacyRevision>(
    db,
    table,
    `SELECT id, page_id, title, content_json,
            ${hasGzip ? "content_gzip" : "NULL AS content_gzip"},
            editor_id, created_at
       FROM ${table}
      ORDER BY created_at, id`
  )

  const out: MigratedRevision[] = []
  for (const row of rows) {
    const mapped = maps.revisions.get(row.id)
    const pageId = maps.pages.get(row.page_id)
    if (mapped === undefined || pageId === undefined) {
      // 页面被彻底删除时版本行本应一起删；真遇到就跳过并留一行日志。
      console.warn(
        `schema_v6: dropping revision ${row.id} (page ${row.page_id} is gone)`
      )
      continue
    }
    const raw = row.content_gzip
      ? await gunzipText(row.content_gzip)
      : (row.content_json ?? "")
    const json = rewritePageLinks(raw, maps.pages)
    out.push({
      json,
      row: {
        id: mapped.id,
        page_id: pageId,
        version_no: mapped.versionNo,
        title: row.title,
        content_hash: await putContent(env, json),
        editor_id: maps.users.get(row.editor_id) ?? 0,
        created_at: row.created_at
      }
    })
  }
  return out
}

type SimpleRow = Record<string, unknown>

interface SimpleTables {
  users: SimpleRow[]
  user2fa: SimpleRow[]
  passkeys: SimpleRow[]
  sessions: SimpleRow[]
  challenges: SimpleRow[]
  spaces: SimpleRow[]
  members: SimpleRow[]
  comments: SimpleRow[]
  importTokens: SimpleRow[]
  readTokens: SimpleRow[]
  emailCodes: SimpleRow[]
  cleanupRuns: SimpleRow[]
}

/**
 * 其余表：逐行映射 id 后变成待插入的行，同时给出「新表应该有幾行」的期望值。
 *
 * 用户归属类表（会话、2FA、令牌、验证码、通行密钥）遇到已注销用户的行直接跳过——
 * 那些行本来就跟着用户删除一起清掉了，跳过只是兜底，不制造指向 0 的幽灵行。
 */
async function buildSimpleTables(
  db: D1Database,
  prefix: string,
  env: MigrationContext["env"],
  maps: IdMaps
): Promise<{ rows: SimpleTables; expected: Record<string, number> }> {
  const userRows = await rowsOf<Record<string, string | number>>(
    db,
    tableName(prefix, "users"),
    `SELECT id, email, password_hash, role, is_active, approval_status,
            email_verified, base_currency, timezone, language, theme,
            username, avatar_key, created_at, updated_at
       FROM ${tableName(prefix, "users")} ORDER BY created_at, id`
  )
  const users: SimpleRow[] = userRows.map((row) => ({
    id: maps.users.get(String(row.id)) ?? 0,
    email: row.email,
    password_hash: row.password_hash,
    role: row.role,
    is_active: row.is_active,
    approval_status: row.approval_status,
    email_verified: row.email_verified,
    base_currency: row.base_currency,
    timezone: row.timezone,
    language: row.language,
    theme: row.theme,
    username: row.username,
    avatar_key: row.avatar_key,
    created_at: row.created_at,
    updated_at: row.updated_at
  }))

  const twofaTable = tableName(prefix, "user_2fa")
  const twofaColumns = await columnNames(db, twofaTable)
  const twofaRows = await rowsOf<{
    user_id: string
    totp_secret: string | null
    totp_enabled: number
    email_otp_enabled: number
    updated_at: string
  }>(
    db,
    twofaTable,
    `SELECT user_id, totp_secret, totp_enabled,
            ${twofaColumns.has("email_otp_enabled") ? "email_otp_enabled" : "0 AS email_otp_enabled"},
            updated_at
       FROM ${twofaTable}`
  )
  const user2fa: SimpleRow[] = []
  for (const row of twofaRows) {
    const userId = maps.users.get(row.user_id)
    if (userId === undefined) continue
    user2fa.push({
      user_id: userId,
      totp_secret: await reencryptTotp(env, row, userId),
      totp_enabled: row.totp_enabled,
      email_otp_enabled: row.email_otp_enabled,
      updated_at: row.updated_at
    })
  }

  const passkeys: SimpleRow[] = (
    await rowsOf<Record<string, unknown>>(
      db,
      tableName(prefix, "passkey_credentials"),
      `SELECT * FROM ${tableName(prefix, "passkey_credentials")} ORDER BY created_at, id`
    )
  ).flatMap((row) => {
    const userId = maps.users.get(String(row.user_id))
    if (userId === undefined) return []
    // 行 id 交给 SQLite 自增：它从未对外暴露，不需要保留旧 UUID 的顺序信息。
    return [
      {
        user_id: userId,
        credential_id: row.credential_id,
        public_key: row.public_key,
        counter: row.counter,
        transports: row.transports,
        created_at: row.created_at,
        last_used_at: row.last_used_at
      }
    ]
  })

  const ownerRows = async (logical: string): Promise<SimpleRow[]> =>
    (
      await rowsOf<Record<string, unknown>>(
        db,
        tableName(prefix, logical),
        `SELECT * FROM ${tableName(prefix, logical)}`
      )
    ).flatMap((row) => {
      const userId = maps.users.get(String(row.user_id))
      if (userId === undefined) return []
      return [{ ...row, user_id: userId }]
    })

  const sessions = await rowsOf<Record<string, unknown>>(
    db,
    tableName(prefix, "sessions"),
    `SELECT * FROM ${tableName(prefix, "sessions")}`
  )
  const remappedSessions = sessions.flatMap((row) => {
    const userId = maps.users.get(String(row.user_id))
    if (userId === undefined) return []
    return [{ ...row, user_id: userId }]
  })

  const challenges = await rowsOf<Record<string, unknown>>(
    db,
    tableName(prefix, "auth_challenges"),
    `SELECT * FROM ${tableName(prefix, "auth_challenges")}`
  )
  const remappedChallenges = challenges.flatMap((row) => {
    const userId = maps.users.get(String(row.user_id))
    if (userId === undefined) return []
    return [{ ...row, user_id: userId }]
  })

  const spaceRows = await rowsOf<Record<string, unknown>>(
    db,
    tableName(prefix, "spaces"),
    `SELECT * FROM ${tableName(prefix, "spaces")} ORDER BY created_at, id`
  )
  const usedSlugs = new Set<string>()
  const spaces: SimpleRow[] = spaceRows.map((row) => {
    const id = maps.spaces.get(String(row.id)) ?? 0
    const name = String(row.name ?? "")
    // 兜底形态也可能撞名（例如真的有人把空间叫「space-7」），发号时收敛到唯一值。
    const slug = uniqueSpaceSlug(name, id, (candidate) =>
      usedSlugs.has(candidate)
    )
    usedSlugs.add(slug)
    return {
      id,
      slug,
      name: row.name,
      description: row.description,
      is_default: row.is_default,
      created_by: maps.users.get(String(row.created_by)) ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  })

  const members = (
    await rowsOf<Record<string, unknown>>(
      db,
      tableName(prefix, "space_members"),
      `SELECT * FROM ${tableName(prefix, "space_members")}`
    )
  ).flatMap((row) => {
    const spaceId = maps.spaces.get(String(row.space_id))
    const userId = maps.users.get(String(row.user_id))
    if (spaceId === undefined || userId === undefined) return []
    return [{ ...row, space_id: spaceId, user_id: userId }]
  })

  const comments = (
    await rowsOf<Record<string, unknown>>(
      db,
      tableName(prefix, "comments"),
      `SELECT * FROM ${tableName(prefix, "comments")} ORDER BY created_at, id`
    )
  ).map((row) => ({
    id: maps.comments.get(String(row.id)) ?? 0,
    page_id: maps.pages.get(String(row.page_id)) ?? 0,
    parent_id:
      row.parent_id === null
        ? null
        : (maps.comments.get(String(row.parent_id)) ?? null),
    author_id: maps.users.get(String(row.author_id)) ?? 0,
    body_md: row.body_md,
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at
  }))

  const importTokens = await ownerRows("import_tokens")
  const readTokens = await ownerRows("read_tokens")
  const emailCodes = await ownerRows("email_codes")

  const cleanupRuns: SimpleRow[] = (
    await rowsOf<Record<string, unknown>>(
      db,
      tableName(prefix, "r2_cleanup_runs"),
      `SELECT * FROM ${tableName(prefix, "r2_cleanup_runs")} ORDER BY started_at, id`
    )
  ).map((row) => ({
    // 行 id 同样交给自增：它只用于排序，旧 UUID 没有保留价值。
    kind: row.kind ?? "images",
    started_at: row.started_at,
    finished_at: row.finished_at,
    trigger: row.trigger,
    status: row.status,
    dry_run: row.dry_run,
    scanned: row.scanned,
    referenced: row.referenced,
    deleted: row.deleted,
    young_skipped: row.young_skipped,
    failed: row.failed,
    truncated: row.truncated
  }))

  const rows: SimpleTables = {
    users,
    user2fa,
    passkeys,
    sessions: remappedSessions,
    challenges: remappedChallenges,
    spaces,
    members,
    comments,
    importTokens,
    readTokens,
    emailCodes,
    cleanupRuns
  }

  return {
    rows,
    expected: {
      users: users.length,
      user_2fa: user2fa.length,
      passkey_credentials: passkeys.length,
      sessions: remappedSessions.length,
      auth_challenges: remappedChallenges.length,
      spaces: spaces.length,
      space_members: members.length,
      comments: comments.length,
      import_tokens: importTokens.length,
      read_tokens: readTokens.length,
      email_codes: emailCodes.length,
      r2_cleanup_runs: cleanupRuns.length
    }
  }
}

/**
 * TOTP 密文的 AAD 绑定了用户 id（`ciki:totp:<userId>`）：id 换形态后必须重加密，
 * 否则老用户的 2FA 直接失效。解不开（密钥轮换过、密文损坏）就整体中止并点名旧 id，
 * 绝不静默清空——那等于替用户把 2FA 关了。
 */
async function reencryptTotp(
  env: MigrationContext["env"],
  row: { user_id: string; totp_secret: string | null },
  newUserId: number
): Promise<string | null> {
  if (!row.totp_secret) return row.totp_secret
  try {
    const plaintext = await decryptSecret(
      env.ENCRYPTION_KEY,
      row.totp_secret,
      `ciki:totp:${row.user_id}`
    )
    return await encryptSecret(
      env.ENCRYPTION_KEY,
      plaintext,
      `ciki:totp:${newUserId}`
    )
  } catch (err) {
    throw new Error(
      `TOTP secret of user ${row.user_id} cannot be decrypted ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `reset that user's 2FA and run the migration again. Nothing was changed.`
    )
  }
}

async function createTempTables(db: D1Database, prefix: string): Promise<void> {
  for (const name of REBUILT_TABLES) {
    await db.prepare(withTable(tableDdl(name), tempName(prefix, name))).run()
  }
}

async function fillTempTables(
  db: D1Database,
  prefix: string,
  pages: MigratedPage[],
  revisions: MigratedRevision[],
  tables: SimpleTables
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  const insert = (logical: string, row: Record<string, unknown>) => {
    statements.push(insertInto(db, tempName(prefix, logical), row))
  }

  for (const row of tables.users) insert("users", row)
  for (const row of tables.user2fa) insert("user_2fa", row)
  for (const row of tables.passkeys) insert("passkey_credentials", row)
  for (const row of tables.sessions) insert("sessions", row)
  for (const row of tables.challenges) insert("auth_challenges", row)
  for (const row of tables.spaces) insert("spaces", row)
  for (const row of tables.members) insert("space_members", row)
  for (const row of tables.comments) insert("comments", row)
  for (const row of tables.importTokens) insert("import_tokens", row)
  for (const row of tables.readTokens) insert("read_tokens", row)
  for (const row of tables.emailCodes) insert("email_codes", row)
  for (const row of tables.cleanupRuns) insert("r2_cleanup_runs", row)

  for (const page of pages) {
    insert("pages", { ...page.row })
    // 软删页不入索引：与运行期软删时清索引的口径一致。
    if (page.row.deleted_at === null) {
      statements.push(
        db
          .prepare(
            `INSERT INTO ${tempName(prefix, "pages_fts")} (page_id, title, content_text) VALUES (?, ?, ?)`
          )
          .bind(
            page.row.id,
            toIndexText(page.row.title),
            toIndexText(page.row.content_text)
          )
      )
    }
  }
  for (const revision of revisions) insert("page_revisions", revision.row)

  await runBatched(db, statements)
}

/** 闸一：每个内容对象都能按指针取回，且解压回读的哈希等于指针（全量，不抽样）。 */
async function verifyObjects(
  env: MigrationContext["env"],
  pages: MigratedPage[],
  revisions: MigratedRevision[]
): Promise<void> {
  const hashes = new Set<string>()
  for (const page of pages) hashes.add(page.row.content_hash)
  for (const revision of revisions) hashes.add(revision.row.content_hash)

  for (const hash of hashes) {
    const text = await readContent(env, hash)
    const actual = await hashContent(text)
    if (actual !== hash) {
      throw new Error(
        `Content object ${hash} failed verification (got ${actual}); nothing was changed`
      )
    }
  }
}

/** 闸二：派生件（html / 纯文本 / MD）只允许发生页面链接改写，其余逐字节不动。 */
function verifyDerived(pages: MigratedPage[], maps: IdMaps): void {
  for (const page of pages) {
    const source = page.source
    if (
      page.row.content_html !==
        rewritePageLinks(source.content_html ?? "", maps.pages) ||
      page.row.content_text !==
        rewritePageLinks(source.content_text ?? "", maps.pages) ||
      page.row.content_md !==
        rewritePageLinks(source.content_md ?? "", maps.pages)
    ) {
      throw new Error(
        `Page ${source.id} derived content changed unexpectedly; nothing was changed`
      )
    }
  }
}

/** 闸三：随机抽 5 页，把 R2 里的 JSON 与迁移前正文逐字节比对。 */
async function verifySampledPages(
  env: MigrationContext["env"],
  db: D1Database,
  prefix: string,
  maps: IdMaps
): Promise<void> {
  const rows = await rowsOf<{ id: string; content_json: string }>(
    db,
    pagesTable(prefix),
    `SELECT id, content_json FROM ${pagesTable(prefix)} ORDER BY created_at, id`
  )
  if (rows.length === 0) return

  const wanted = Math.min(SAMPLED_PAGES, rows.length)
  const picks = new Set<number>()
  const random = new Uint32Array(1)
  while (picks.size < wanted) {
    crypto.getRandomValues(random)
    picks.add(random[0] % rows.length)
  }

  for (const index of picks) {
    const row = rows[index]
    const pageId = maps.pages.get(row.id)
    if (pageId === undefined) continue
    const stored = await db
      .prepare(
        `SELECT content_hash FROM ${tempName(prefix, "pages")} WHERE id = ?`
      )
      .bind(pageId)
      .first<{ content_hash: string }>()
    if (!stored) {
      throw new Error(`Migrated page ${pageId} is missing; nothing was changed`)
    }
    const json = await readContent(env, stored.content_hash)
    if (json !== rewritePageLinks(row.content_json ?? "", maps.pages)) {
      throw new Error(
        `Page ${row.id} content mismatch after migration; nothing was changed`
      )
    }
  }
}

/** 闸四：每个非空 `parent_id` 都能在迁移后的页面集合里找到，且与子页同空间。 */
function verifyParentLinks(pages: MigratedPage[]): void {
  const byId = new Map(pages.map((page) => [page.row.id, page]))
  for (const page of pages) {
    if (page.row.parent_id === null) continue
    const parent = byId.get(page.row.parent_id)
    if (!parent) {
      throw new Error(
        `Page ${page.row.id} points at missing parent ${page.row.parent_id}; nothing was changed`
      )
    }
    if (parent.row.space_id !== page.row.space_id) {
      throw new Error(
        `Page ${page.row.id} and its parent ${parent.row.id} are in different spaces; nothing was changed`
      )
    }
  }
}

/**
 * 闸五：逐表行数与逐页版本数。
 *
 * `version_no` 的连续性由发号函数保证（`assignVersionNos` 逐页从 1 递增），唯一索引
 * `(page_id, version_no)` 在写入临时表时再兜一道。
 */
async function verifyCounts(
  db: D1Database,
  prefix: string,
  expected: Record<string, number>,
  maps: IdMaps
): Promise<void> {
  for (const [logical, count] of Object.entries(expected)) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${tempName(prefix, logical)}`)
      .first<{ count: number }>()
    const actual = row?.count ?? 0
    if (actual !== count) {
      throw new Error(
        `Table ${logical} lost rows during migration (expected ${count}, got ${actual}); nothing was changed`
      )
    }
  }

  // 版本数逐页核对：新表里每页的条数必须等于旧表里的条数。
  const oldCounts = await rowsOf<{ page_id: string; count: number }>(
    db,
    tableName(prefix, "page_revisions"),
    `SELECT page_id, COUNT(*) AS count FROM ${tableName(prefix, "page_revisions")} GROUP BY page_id`
  )
  const newCounts = await db
    .prepare(
      `SELECT page_id, COUNT(*) AS count FROM ${tempName(prefix, "page_revisions")} GROUP BY page_id`
    )
    .all<{ page_id: number; count: number }>()
  const byPage = new Map(
    newCounts.results.map((row) => [row.page_id, row.count])
  )
  for (const row of oldCounts) {
    const newPageId = maps.pages.get(row.page_id)
    if (newPageId === undefined) continue
    const actual = byPage.get(newPageId) ?? 0
    if (actual !== row.count) {
      throw new Error(
        `Page ${row.page_id} lost revisions during migration (expected ${row.count}, got ${actual}); nothing was changed`
      )
    }
  }
}

/** 切换：逐表 DROP 旧 + RENAME 临时表（单事务），索引随后幂等补建。 */
async function swapTables(db: D1Database, prefix: string): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const name of REBUILT_TABLES) {
    statements.push(
      db.prepare(`DROP TABLE IF EXISTS ${tableName(prefix, name)}`)
    )
    statements.push(
      db.prepare(
        `ALTER TABLE ${tempName(prefix, name)} RENAME TO ${tableName(prefix, name)}`
      )
    )
  }
  await db.batch(statements)
}
