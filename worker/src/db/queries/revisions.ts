import { revisionsTable } from "../../lib/tables"

export interface RevisionRow {
  id: string
  page_id: string
  title: string
  content_json: string
  content_html: string
  content_text: string
  editor_id: string
  created_at: string
}

export function insertRevision(
  db: D1Database,
  prefix: string,
  revision: RevisionRow
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ${revisionsTable(prefix)}
        (id, page_id, title, content_json, content_html, content_text, editor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      revision.id,
      revision.page_id,
      revision.title,
      revision.content_json,
      revision.content_html,
      revision.content_text,
      revision.editor_id,
      revision.created_at
    )
}

export async function listRevisions(
  db: D1Database,
  prefix: string,
  pageId: string
): Promise<RevisionRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM ${revisionsTable(prefix)} WHERE page_id = ? ORDER BY created_at DESC, rowid DESC`
    )
    .bind(pageId)
    .all<RevisionRow>()
  return rows.results
}

export async function getRevision(
  db: D1Database,
  prefix: string,
  pageId: string,
  revisionId: string
): Promise<RevisionRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${revisionsTable(prefix)} WHERE id = ? AND page_id = ?`
    )
    .bind(revisionId, pageId)
    .first<RevisionRow>()
}
