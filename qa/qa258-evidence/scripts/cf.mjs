// QA258 生产辅助：CF API 直调（D1 查询/执行 + R2 列举/删除）
// token 只在进程内从 wrangler 配置读取，绝不打印、绝不落盘
import fs from "node:fs"
import crypto from "node:crypto"

const CF_TOKEN_PATH = process.env.HOME + "/.wrangler/config/default.toml"
export function readToken() {
  const raw = fs.readFileSync(CF_TOKEN_PATH, "utf8")
  const m = raw.match(/oauth_token\s*=\s*"([^"]+)"/)
  if (!m) throw new Error("no oauth_token")
  return m[1]
}
let CF_TOKEN = readToken()
export const ACCOUNT = "967399d1b7212c427f5c032b7f7618f2"
export const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`

/** token 过期时用 wrangler 刷新（whoami 会自动续期），再重读 */
async function refreshToken() {
  const { execFileSync } = await import("node:child_process")
  execFileSync("pnpm", ["exec", "wrangler", "whoami"], {
    cwd: "/tmp/ciki-qa258/base/worker",
    env: { ...process.env, PATH: `${process.env.HOME}/Library/pnpm:/opt/homebrew/bin:${process.env.PATH}` },
    stdio: "ignore"
  })
  CF_TOKEN = readToken()
}

export async function cf(path, init = {}, _retry = true) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  })
  if (res.status === 401 && _retry) {
    await refreshToken()
    return cf(path, init, false)
  }
  const txt = await res.text()
  let json
  try { json = JSON.parse(txt) } catch { json = { raw: txt.slice(0, 400) } }
  if (!res.ok) {
    throw new Error(`CF ${init.method || "GET"} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json
}

/** D1 查询：返回 result[] */
export async function d1(dbId, sql, params = []) {
  const j = await cf(`/d1/database/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params })
  })
  if (!j.success) throw new Error(`D1 query failed: ${JSON.stringify(j).slice(0, 300)}`)
  const r = j.result?.[0]
  return r?.results ?? []
}

/** D1 批量执行（多语句按顺序单条发送，d1/database/{id}/query 支持多语句） */
export async function d1exec(dbId, statements) {
  const out = []
  for (const { sql, params = [] } of statements) {
    const j = await cf(`/d1/database/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, params })
    })
    if (!j.success) throw new Error(`D1 exec failed: ${JSON.stringify(j).slice(0, 300)}`)
    out.push(j.result?.map(r => r.results ?? []))
  }
  return out
}

/** R2 全量 LIST（跟随游标）→ key 数组 */
export async function r2list(bucket) {
  const keys = []
  let cursor = null
  let page = 0
  do {
    const q = cursor ? `?per_page=1000&cursor=${encodeURIComponent(cursor)}` : "?per_page=1000"
    const j = await cf(`/r2/buckets/${bucket}/objects${q}`)
    if (!j.success) throw new Error(`R2 list failed: ${JSON.stringify(j).slice(0, 300)}`)
    const objs = j.result || []
    keys.push(...objs.map(o => o.key))
    page++
    const p = j.result_info?.pagination
    cursor = j.result_info?.cursor ?? p?.cursor ?? p?.next_cursor ?? null
    if (page === 1) console.error(`[r2list ${bucket}] page1=${objs.length} cursor=${cursor ? "yes" : "no"}`)
  } while (cursor && page < 20)
  return keys
}

export async function r2delete(bucket, key) {
  const res = await fetch(`${API}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${CF_TOKEN}` }
  })
  if (!res.ok && res.status !== 204) {
    const t = await res.text()
    throw new Error(`R2 delete ${key} -> ${res.status} ${t.slice(0, 200)}`)
  }
  return res.status
}

export async function r2put(bucket, key, body, contentType = "text/html; charset=utf-8") {
  const res = await fetch(`${API}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": contentType },
    body
  })
  if (!res.ok) throw new Error(`R2 put ${key} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.status
}

export function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}

/** 口令哈希：PBKDF2-SHA256 / 100000 次 / 32B 盐 / 32B 输出，格式 saltHex:hashHex */
export function hashPassword(password, salt = crypto.randomBytes(32)) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256")
  return `${salt.toString("hex")}:${hash.toString("hex")}`
}

export function uuid() {
  return crypto.randomUUID()
}
export function randHex(n = 32) {
  return crypto.randomBytes(n).toString("hex")
}
export function randB64url(n = 32) {
  return crypto.randomBytes(n).toString("base64url")
}
