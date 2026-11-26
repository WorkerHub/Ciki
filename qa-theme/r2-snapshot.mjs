#!/usr/bin/env node
// R2 全量快照（分页跟随 cursor）—— 基线与终态比对用
import { execSync } from "node:child_process"
import { writeFileSync, readFileSync } from "node:fs"

const ACCOUNT = "967399d1b7212c427f5c032b7f7618f2"
const BUCKETS = ["ciki-assets", "ciki-content"]

function token() {
  return execSync(
    `awk -F'"' '/^oauth_token/{print $2}' ~/.wrangler/config/default.toml`
  )
    .toString()
    .trim()
}

async function listAll(bucket) {
  const out = []
  let cursor = null
  for (let page = 0; ; page++) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${bucket}/objects?per_page=1000` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}` }
    })
    if (!res.ok) throw new Error(`${bucket} HTTP ${res.status}`)
    const d = await res.json()
    if (!d.success) throw new Error(`${bucket} SAPI error: ${JSON.stringify(d.errors)}`)
    const items = Array.isArray(d.result) ? d.result : []
    out.push(
      ...items.map((o) => ({ key: o.key, size: o.size, lm: o.last_modified }))
    )
    const info = d.result_info ?? {}
    const truncated = info.is_truncated === true || info.isTruncated === true
    cursor = info.cursor ?? (info.pagination && info.pagination.cursor) ?? null
    if (!truncated || !cursor) break
    if (page > 50) throw new Error("too many pages")
  }
  return out
}

const out = {}
for (const b of BUCKETS) {
  const objs = await listAll(b)
  out[b] = objs
  const byPrefix = {}
  for (const o of objs) {
    const p = o.key.split("/")[0]
    byPrefix[p] = (byPrefix[p] ?? 0) + 1
  }
  console.error(`${b}: ${objs.length} objects`, JSON.stringify(byPrefix))
}

const dest = process.argv[2]
if (dest) {
  writeFileSync(dest, JSON.stringify(out, null, 1))
  console.error(`written -> ${dest}`)
}
