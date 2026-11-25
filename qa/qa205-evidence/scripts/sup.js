/* QA #205 补充证据：视口截图拍 Agent 卡片区域（主运行 metrics.json 断言已 35/35，
 * 本脚本重放关键状态并以元素滚动入视口的方式截图，同时复验关键断言）。 */
const { chromium } = require("playwright-core")
const fs = require("fs")
const path = require("path")

const BASE = "http://127.0.0.1:8795"
const EV = "/tmp/qa205/evidence"
const SHOTS = path.join(EV, "shots")
fs.mkdirSync(SHOTS, { recursive: true })

const EXEC =
  "/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const jar = fs.readFileSync("/tmp/qa205/cookies.txt", "utf8")
const session = jar.split("\n").find((l) => l.includes("ciki_session")).trim().split(/\s+/).pop()

const results = []
const reqLog = []
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? "" : detail })
  console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""))
}
async function shot(page, tag) {
  const f = `sup-${tag}.png`
  await page.screenshot({ path: path.join(SHOTS, f) })
  console.log("SHOT " + f)
}
async function api(p) {
  return fetch(BASE + p, { headers: { cookie: `ciki_session=${session}` } })
}
const AVATAR_MUT_RE = /^\/api\/me\/(agents\/\d+\/avatar|avatar)$/
function mutsSince(mark) {
  return reqLog.slice(mark).filter((e) => e.kind === "request" && (e.method === "POST" || e.method === "DELETE") && AVATAR_MUT_RE.test(e.path))
}

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXEC,
    proxy: { server: "http://127.0.0.1:7890", bypass: "127.0.0.1,localhost" }
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" })
  await context.addCookies([{ name: "ciki_session", value: session, url: BASE }])
  const page = await context.newPage()
  page.on("request", (req) => {
    const u = new URL(req.url())
    if (u.pathname.startsWith("/api/")) reqLog.push({ ts: Date.now(), kind: "request", method: req.method(), path: u.pathname })
  })
  page.on("response", (res) => {
    const u = new URL(res.url())
    if (u.pathname.startsWith("/api/")) reqLog.push({ ts: Date.now(), kind: "response", method: res.request().method(), path: u.pathname, status: res.status() })
  })

  const dialog = page.getByRole("dialog")
  const cropBox = dialog.locator('[data-testid="crop-box"]')

  await page.goto(BASE + "/settings")
  await page.getByText("我的 Agent 账号").waitFor({ timeout: 15000 })
  await page.getByText("qa-agent-alpha").waitFor({ timeout: 15000 })
  const alphaRow = page.locator("li").filter({ hasText: "qa-agent-alpha" })
  const betaRow = page.locator("li").filter({ hasText: "qa-agent-beta" })
  await alphaRow.scrollIntoViewIfNeeded()
  await shot(page, "00-agent-card-initial")

  // ---- alpha 上传（重放项 1 状态） ----
  let mark = reqLog.length
  await page.locator('input[aria-label="为 qa-agent-alpha 选择头像"]').setInputFiles("/tmp/qa205/images/qa-a.png")
  await dialog.waitFor({ state: "visible", timeout: 10000 })
  await cropBox.waitFor({ state: "visible", timeout: 10000 })
  await dialog.getByRole("button", { name: "确定" }).click()
  await page.getByRole("status").getByText("Agent 头像已更新。").waitFor({ timeout: 15000 })
  const muts1 = mutsSince(mark)
  assert("sup: alpha 上传恰 1 次 POST", muts1.length === 1 && muts1[0].path === "/api/me/agents/2/avatar", muts1)
  const agents1 = await (await api("/api/me/agents")).json()
  const alphaUrl = agents1.find((a) => a.username === "qa-agent-alpha").avatarUrl
  assert("sup: alpha.avatarUrl 更新", /\/api\/files\/avatars\//.test(alphaUrl), alphaUrl)
  const r = await fetch(BASE + alphaUrl, { headers: { cookie: `ciki_session=${session}` } })
  const buf = Buffer.from(await r.arrayBuffer())
  fs.writeFileSync(path.join(EV, "files", "sup-alpha.webp"), buf)
  assert("sup: alpha 落盘 WebP", r.status === 200 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP", { bytes: buf.length })
  await alphaRow.scrollIntoViewIfNeeded()
  await shot(page, "01-alpha-uploaded-notice")

  // ---- beta 取消（重放项 2 状态） ----
  mark = reqLog.length
  await page.locator('input[aria-label="为 qa-agent-beta 选择头像"]').setInputFiles("/tmp/qa205/images/qa-b.png")
  await dialog.waitFor({ state: "visible", timeout: 10000 })
  await cropBox.waitFor({ state: "visible", timeout: 10000 })
  await dialog.getByRole("button", { name: "取消" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 5000 })
  await page.waitForTimeout(800)
  assert("sup: 取消无头像变更请求", mutsSince(mark).length === 0)
  const agents2 = await (await api("/api/me/agents")).json()
  const betaAfter = agents2.find((a) => a.username === "qa-agent-beta").avatarUrl
  assert("sup: 取消后 beta 头像不变", betaAfter === agents1.find((a) => a.username === "qa-agent-beta").avatarUrl, { before: agents1.find((a) => a.username === "qa-agent-beta").avatarUrl, after: betaAfter })
  await betaRow.scrollIntoViewIfNeeded()
  await shot(page, "02-beta-cancelled-unchanged")

  // ---- alpha 解码失败（重放项 4a 状态） ----
  mark = reqLog.length
  await page.locator('input[aria-label="为 qa-agent-alpha 选择头像"]').setInputFiles("/tmp/qa205/images/qa-bad.png")
  const errAlert = page.locator('p[role="alert"]').filter({ hasText: "图片解码失败" })
  await errAlert.waitFor({ state: "visible", timeout: 10000 })
  assert("sup: 解码失败提示可见", await errAlert.isVisible())
  assert("sup: 解码失败无上传请求", mutsSince(mark).length === 0)
  await errAlert.scrollIntoViewIfNeeded()
  await shot(page, "03-decode-error-alert")

  // ---- alpha 删除头像（重放项 4b 状态） ----
  mark = reqLog.length
  await alphaRow.getByRole("button", { name: "删除头像" }).click()
  await page.getByRole("status").getByText("Agent 头像已删除。").waitFor({ timeout: 15000 })
  const agents3 = await (await api("/api/me/agents")).json()
  assert("sup: alpha.avatarUrl 置空", agents3.find((a) => a.username === "qa-agent-alpha").avatarUrl === null)
  await alphaRow.scrollIntoViewIfNeeded()
  await shot(page, "04-alpha-avatar-deleted")

  // ---- 资料页（重放项 5 状态） ----
  await page.goto(BASE + "/profile")
  await page.locator('input[aria-label="选择头像"]').waitFor({ timeout: 15000 })
  mark = reqLog.length
  await page.locator('input[aria-label="选择头像"]').setInputFiles("/tmp/qa205/images/qa-c.png")
  await dialog.waitFor({ state: "visible", timeout: 10000 })
  await cropBox.waitFor({ state: "visible", timeout: 10000 })
  await dialog.getByRole("button", { name: "确定" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 5000 })
  const saveBtn = page.getByRole("button", { name: "保存", exact: true })
  await saveBtn.waitFor({ state: "visible", timeout: 10000 })
  assert("sup: 预览阶段无上传", mutsSince(mark).length === 0)
  await shot(page, "05-profile-preview-savebtn")
  await saveBtn.click()
  await page.getByRole("status").waitFor({ timeout: 15000 })
  const me = await (await api("/api/me")).json()
  assert("sup: 自己头像更新", /\/api\/files\/avatars\//.test(me.avatarUrl), me.avatarUrl)
  const rp = await fetch(BASE + me.avatarUrl, { headers: { cookie: `ciki_session=${session}` } })
  const bp = Buffer.from(await rp.arrayBuffer())
  fs.writeFileSync(path.join(EV, "files", "sup-profile.webp"), bp)
  assert("sup: 资料页落盘 WebP", rp.status === 200 && bp.slice(0, 4).toString("latin1") === "RIFF" && bp.slice(8, 12).toString("latin1") === "WEBP", { bytes: bp.length })
  await shot(page, "06-profile-saved")

  fs.writeFileSync(path.join(EV, "sup-metrics.json"), JSON.stringify({ results, shots: fs.readdirSync(SHOTS).filter((f) => f.startsWith("sup-")), requests: reqLog }, null, 2))
  const failed = results.filter((x) => !x.pass)
  console.log(`\n=== SUP SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await browser.close()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error("SUP ERROR:", e)
  fs.writeFileSync(path.join(EV, "sup-metrics.json"), JSON.stringify({ results, reqLog, fatal: String(e && e.stack || e) }, null, 2))
  process.exit(2)
})
