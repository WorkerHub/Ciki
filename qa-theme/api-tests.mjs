#!/usr/bin/env node
// Ciki 主题全矩阵 QA —— PUT /api/me/theme 合法/非法矩阵 + 未知值回退 + 会话门禁
import { readFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { Api, clean, report } from "./lib.mjs"

const state = JSON.parse(readFileSync(new URL("./state.json", import.meta.url)))
const results = []
const t = (name, pass, detail) => {
  results.push({ name, pass, detail })
  report(name, pass, detail)
}

function wrangler(sql) {
  const quoted = "'" + sql.replace(/'/g, "'\\''") + "'"
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = execSync(
        `npx --yes wrangler d1 execute ciki --remote --json --command ${quoted}`,
        { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }
      ).toString()
      return JSON.parse(out.slice(out.indexOf("[")))[0].results
    } catch (err) {
      if (attempt === 3) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000)
    }
  }
}

const A = new Api("A")
A.cookies.set("ciki_session", state.cookies.A)

// ── 1. 合法值四套 ───────────────────────────────────────────────
for (const style of ["nova", "paper", "natural", "eink"]) {
  const r = await A.json("PUT", "/api/me/theme", { themeStyle: style })
  const ok =
    r.status === 200 &&
    r.data?.themeStyle === style &&
    r.data?.id === state.users.A.id
  t(`PUT theme=${style} → 200 且回读一致`, ok, `status=${r.status} themeStyle=${r.data?.themeStyle}`)
  const me = await A.json("GET", "/api/me")
  t(
    `GET /api/me themeStyle=${style} 保持`,
    me.status === 200 && me.data?.themeStyle === style,
    `themeStyle=${me.data?.themeStyle}`
  )
  // D1 落库核对
  const row = wrangler(`SELECT theme_style FROM users WHERE id = ${state.users.A.id}`)[0]
  t(`D1 users.theme_style=${style} 落库`, row?.theme_style === style, `db=${row?.theme_style}`)
}

// ── 2. 非法值拒绝 ───────────────────────────────────────────────
const illegal = ["blue", "NOVA", "Natural", "eink ", "", "dark", "nova\n", "null-ish"]
for (const style of illegal) {
  const r = await A.json("PUT", "/api/me/theme", { themeStyle: style })
  const body = JSON.stringify(r.data)
  const ok =
    r.status === 400 &&
    r.data?.code === "INVALID_THEME_STYLE" &&
    /must be nova, paper, natural or eink/i.test(body)
  t(`PUT theme=${JSON.stringify(style)} → 400 INVALID_THEME_STYLE`, ok, `status=${r.status} body=${clean(body).slice(0, 120)}`)
  // 拒绝后旧值不被破坏
  const me = await A.json("GET", "/api/me")
  t(`  拒绝后 themeStyle 保持 eink`, me.data?.themeStyle === "eink", `themeStyle=${me.data?.themeStyle}`)
}

// ── 3. 兼容别名 style 字段 ──────────────────────────────────────
{
  const r = await A.json("PUT", "/api/me/theme", { style: "paper" })
  t("PUT {style:'paper'}（兼容字段）→ 200", r.status === 200 && r.data?.themeStyle === "paper", `status=${r.status} themeStyle=${r.data?.themeStyle}`)
  await A.json("PUT", "/api/me/theme", { themeStyle: "eink" })
}

// ── 4. 未知值回退 nova（normalizeThemeStyle：库内脏值 → nova） ──
wrangler(`UPDATE users SET theme_style = 'bogus-value' WHERE id = ${state.users.A.id}`)
const me2 = await A.json("GET", "/api/me")
t(
  "库内脏值 bogus-value → /api/me 归一化 nova",
  me2.status === 200 && me2.data?.themeStyle === "nova",
  `themeStyle=${me2.data?.themeStyle}`
)
const pageRes = await A.json("GET", `/api/pages/${state.pageId}`)
// 恢复
wrangler(`UPDATE users SET theme_style = 'nova' WHERE id = ${state.users.A.id}`)

// ── 5. 未登录 401 ───────────────────────────────────────────────
{
  const anon = new Api("anon")
  const r = await anon.json("PUT", "/api/me/theme", { themeStyle: "natural" })
  t("未登录 PUT /api/me/theme → 401", r.status === 401, `status=${r.status}`)
}
{
  const bad = new Api("bad")
  bad.cookies.set("ciki_session", "totally-invalid-token-value-000")
  const r = await bad.json("PUT", "/api/me/theme", { themeStyle: "natural" })
  t("无效会话 PUT → 401", r.status === 401, `status=${r.status}`)
}

// ── 6. B 账号同样四套可写（普通用户） ───────────────────────────
{
  const B = new Api("B")
  B.cookies.set("ciki_session", state.cookies.B)
  for (const style of ["natural", "eink", "nova", "paper"]) {
    const r = await B.json("PUT", "/api/me/theme", { themeStyle: style })
    t(`B(普通用户) PUT theme=${style} → 200`, r.status === 200 && r.data?.themeStyle === style, `status=${r.status}`)
  }
}

writeFileSync(
  new URL("./evidence/api-theme-tests.json", import.meta.url),
  JSON.stringify(results, null, 1)
)
const passCount = results.filter((r) => r.pass).length
console.log(`\nAPI TESTS: ${passCount}/${results.length} passed`)
if (passCount !== results.length) process.exit(1)
