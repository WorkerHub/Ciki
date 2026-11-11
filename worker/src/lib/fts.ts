/**
 * FTS5 同步与查询构造（规格 §6：验收只看结果——保存后可搜到、改名/改文后更新、
 * 软删不出现）。
 *
 * CJK 没有天然分词：写入与查询都把汉字/假名/谚文逐字加空格，汉字词按短语
 * `"团 队"` 匹配、拉丁词按前缀 `"ciki"*` 匹配，多词 AND。索引写入与页面保存在
 * 同一个 `db.batch()` 事务里，避免表与索引漂移。
 */
import { pagesFtsTable } from "./tables"
import { toPlainText } from "./sanitize"

const CJK_CHAR =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g
const CJK_TEST =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 逐字空格化（写入与查询共用同一函数，保证两侧 token 对齐）。 */
export function toIndexText(input: string): string {
  return input
    .replace(CJK_CHAR, (ch) => ` ${ch} `)
    .replace(/\s+/g, " ")
    .trim()
}

/** 把用户输入翻成 FTS5 MATCH 表达式；没有可用词时返回 null。 */
export function toMatchQuery(input: string): string | null {
  const terms = input.trim().split(/\s+/).filter(Boolean).slice(0, 6)
  const parts: string[] = []
  for (const raw of terms) {
    // 去掉 FTS5 语法字符，避免用户输入变成查询语法。
    const cleaned = raw.replace(/["'(){}:*^,.;!?[\]\\]/g, "").trim()
    if (!cleaned) continue
    const indexed = toIndexText(cleaned)
    if (!indexed) continue
    if (CJK_TEST.test(cleaned)) parts.push(`"${indexed}"`)
    else parts.push(`"${indexed}"*`)
  }
  return parts.length > 0 ? parts.join(" AND ") : null
}

/** 从原文生成命中附近的纯文本片段（前端自行高亮，返回内容不含 HTML）。 */
export function makeSnippet(text: string, query: string, max = 160): string {
  // 片段必须是纯文本（契约）：title/content_text 是客户端输入，剥标签后再返回。
  const body = toPlainText(text)
  if (!body) return ""
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["'(){}:*^,.;!?[\]\\]/g, "").toLowerCase())
    .filter((term) => term.length > 0)
  const lower = body.toLowerCase()
  let start = -1
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at !== -1 && (start === -1 || at < start)) start = at
  }
  if (start === -1) return body.slice(0, max)
  const from = Math.max(0, start - 40)
  const to = Math.min(body.length, from + max)
  return `${from > 0 ? "…" : ""}${body.slice(from, to)}${to < body.length ? "…" : ""}`
}

/** 页面索引行（删除旧索引 + 插入新索引）。 */
export function indexPageStatements(
  db: D1Database,
  prefix: string,
  page: { id: number; title: string; contentText: string }
): D1PreparedStatement[] {
  const table = pagesFtsTable(prefix)
  return [
    db.prepare(`DELETE FROM ${table} WHERE page_id = ?`).bind(page.id),
    db
      .prepare(
        `INSERT INTO ${table} (page_id, title, content_text) VALUES (?, ?, ?)`
      )
      .bind(page.id, toIndexText(page.title), toIndexText(page.contentText))
  ]
}

/**
 * 新页面的索引行：`page_id` 取同一 batch 里刚插入的页面行（`last_insert_rowid()`）。
 *
 * 与 {@link insertFirstRevision} 同一口径：建页时 id 由自增分配，页面 INSERT 之后
 * 紧跟着的这条语句才能拿到它。调用方必须把它排在页面 INSERT 之后。
 */
export function firstPageIndexStatement(
  db: D1Database,
  prefix: string,
  page: { title: string; contentText: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ${pagesFtsTable(prefix)} (page_id, title, content_text)
       VALUES (last_insert_rowid(), ?, ?)`
    )
    .bind(toIndexText(page.title), toIndexText(page.contentText))
}

/** 从索引里删除若干页面（软删/彻底删用）。 */
export function deleteIndexStatements(
  db: D1Database,
  prefix: string,
  pageIds: number[]
): D1PreparedStatement[] {
  const table = pagesFtsTable(prefix)
  return pageIds.map((id) =>
    db.prepare(`DELETE FROM ${table} WHERE page_id = ?`).bind(id)
  )
}
