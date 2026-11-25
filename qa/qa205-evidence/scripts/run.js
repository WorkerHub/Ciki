/* QA #205 — Agent 头像裁剪验收（Jim 真跑）
 * 生产版本门：v1.0.0-284-c5b0255（已另行核对）；本地同 commit 实例 127.0.0.1:8795。
 * 口令不落盘：会话 cookie 从本机 curl jar 读取；测试文件均为本机生成。
 */
const { chromium } = require("playwright-core")
const fs = require("fs")
const path = require("path")

const BASE = "http://127.0.0.1:8795"
const EV = "/tmp/qa205/evidence"
const SHOTS = path.join(EV, "shots")
const FILES = path.join(EV, "files")
fs.mkdirSync(SHOTS, { recursive: true })
fs.mkdirSync(FILES, { recursive: true })

const EXEC =
  "/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

// 会话 cookie（本机 curl jar，仅本机使用）
const jar = fs.readFileSync("/tmp/qa205/cookies.txt", "utf8")
const session = jar
  .split("\n")
  .find((l) => l.includes("ciki_session"))
  .trim()
  .split(/\s+/)
  .pop()

const results = []
const reqLog = []
const stateTimeline = []
const shots = []
let shotIdx = 0

function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? "" : detail })
  console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""))
}

async function shot(page, tag) {
  shotIdx++
  const f = `${String(shotIdx).padStart(2, "0")}-${tag}.png`
  await page.screenshot({ path: path.join(SHOTS, f), fullPage: true })
  shots.push(f)
  console.log("SHOT " + f)
}

async function api(p) {
  const r = await fetch(BASE + p, { headers: { cookie: `ciki_session=${session}` } })
  return r
}

const AVATAR_MUT_RE = /^\/api\/me\/(agents\/\d+\/avatar|avatar)$/
function avatarMutationsSince(mark) {
  return reqLog
    .slice(mark)
    .filter((e) => e.kind === "request" && (e.method === "POST" || e.method === "DELETE") && AVATAR_MUT_RE.test(e.path))
}
function responsesSince(mark, re) {
  return reqLog.slice(mark).filter((e) => e.kind === "response" && re.test(e.path))
}

async function snapState(tag) {
  const [agentsR, meR] = [await api("/api/me/agents"), await api("/api/me")]
  const agents = await agentsR.json()
  const me = await meR.json()
  stateTimeline.push({
    tag,
    ts: new Date().toISOString(),
    agents: agents.map((a) => ({ id: a.id, username: a.username, avatarUrl: a.avatarUrl })),
    meAvatarUrl: me.avatarUrl
  })
  return { agents, me }
}

async function saveAvatarFile(url, name) {
  const r = await fetch(BASE + url, { headers: { cookie: `ciki_session=${session}` } })
  const buf = Buffer.from(await r.arrayBuffer())
  fs.writeFileSync(path.join(FILES, name), buf)
  const riff = buf.slice(0, 4).toString("latin1")
  const webp = buf.slice(8, 12).toString("latin1")
  return { status: r.status, bytes: buf.length, isWebp: riff === "RIFF" && webp === "WEBP", contentType: r.headers.get("content-type") }
}

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: EXEC,
    proxy: { server: "http://127.0.0.1:7890", bypass: "127.0.0.1,localhost" }
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block"
  })
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

  // ============ 前置：设置页 + 初始状态 ============
  await page.goto(BASE + "/settings")
  await page.getByText("我的 Agent 账号").waitFor({ timeout: 15000 })
  await page.getByText("qa-agent-alpha").waitFor({ timeout: 15000 })
  await shot(page, "settings-agents-initial")
  const s0 = await snapState("initial")
  assert("前置: alpha 初始无头像", s0.agents.find((a) => a.username === "qa-agent-alpha").avatarUrl === null)
  assert("前置: beta 初始无头像", s0.agents.find((a) => a.username === "qa-agent-beta").avatarUrl === null)
  assert("前置: 管理员本人初始无头像", s0.me.avatarUrl === null)

  // ============ 项 1：alpha 换头像（非方形大图 → 裁剪 → 确认 → 512×512 WebP） ============
  const inAlpha = page.locator('input[aria-label="为 qa-agent-alpha 选择头像"]')
  await inAlpha.setInputFiles("/tmp/qa205/images/qa-a.png")
  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible", timeout: 10000 })
  await dialog.getByRole("heading", { name: "裁剪头像" }).waitFor({ timeout: 10000 })
  const cropBox = dialog.locator('[data-testid="crop-box"]')
  await cropBox.waitFor({ state: "visible", timeout: 10000 })
  assert("项1: 裁剪对话框打开且选区可见", await cropBox.isVisible())
  await shot(page, "crop-dialog-open")

  const canvas = dialog.locator("canvas")
  const cb0 = await canvas.boundingBox()
  const bb0 = await cropBox.boundingBox()
  // 拖动选区：向左 50px（初始居中，左移不受钳制）
  const cx = bb0.x + bb0.width / 2
  const cy = bb0.y + bb0.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - i * 5, cy)
  await page.mouse.up()
  await page.waitForTimeout(200)
  const bb1 = await cropBox.boundingBox()
  assert("项1: 选区可拖动（x 左移≈50px）", Math.abs(bb1.x - (bb0.x - 50)) < 8, { dx: +(bb1.x - bb0.x).toFixed(1) })
  assert("项1: 拖动后选区仍在画布内", bb1.x >= cb0.x - 1 && bb1.x + bb1.width <= cb0.x + cb0.width + 1)
  await shot(page, "crop-dragged")

  // 缩放：End → 最小选区；Home → 最大选区
  const thumb = dialog.locator('[role="slider"]')
  await thumb.click()
  await page.keyboard.press("End")
  await page.waitForTimeout(200)
  const bb2 = await cropBox.boundingBox()
  assert("项1: 选区可缩小（End）", bb2.width < bb1.width - 5, { w: [bb1.width, bb2.width].map((v) => +v.toFixed(1)) })
  await shot(page, "crop-zoom-min")
  await page.keyboard.press("Home")
  await page.waitForTimeout(200)
  const bb3 = await cropBox.boundingBox()
  assert("项1: 选区可放大回满（Home，短边全幅）", Math.abs(bb3.height - bb1.height) < 3, { h: [bb1.height, bb3.height].map((v) => +v.toFixed(1)) })
  // 选区占源图短边比例 ≥ 512/2000
  const ratio = bb3.height / cb0.height
  const srcSel = Math.round(ratio * 2000)
  assert("项1: 最终选区源尺寸 ≥512px", srcSel >= 512, { ratio: +ratio.toFixed(3), srcSel })
  await shot(page, "crop-final-max")

  let mark = reqLog.length
  await dialog.getByRole("button", { name: "确定" }).click()
  await page.getByRole("status").getByText("Agent 头像已更新。").waitFor({ timeout: 15000 })
  await dialog.waitFor({ state: "hidden", timeout: 5000 })
  const posts = avatarMutationsSince(mark)
  assert("项1: 确认后恰好 1 次上传请求", posts.length === 1 && posts[0].method === "POST" && posts[0].path === "/api/me/agents/2/avatar", posts)
  const postsRes = responsesSince(mark, /^\/api\/me\/agents\/2\/avatar$/)
  assert("项1: 上传响应 200", postsRes.some((r) => r.status === 200), postsRes)
  const s1 = await snapState("after-item1")
  const alpha1 = s1.agents.find((a) => a.username === "qa-agent-alpha")
  assert("项1: alpha.avatarUrl 已更新", typeof alpha1.avatarUrl === "string" && /\/api\/files\/avatars\//.test(alpha1.avatarUrl), alpha1.avatarUrl)
  const alphaRow = page.locator("li").filter({ hasText: "qa-agent-alpha" })
  await alphaRow.locator("img[alt='qa-agent-alpha']").waitFor({ timeout: 10000 })
  const uiSrc = await alphaRow.locator("img[alt='qa-agent-alpha']").getAttribute("src")
  assert("项1: 行内头像 img src 与接口一致", uiSrc === alpha1.avatarUrl, { uiSrc, api: alpha1.avatarUrl })
  const saved1 = await saveAvatarFile(alpha1.avatarUrl, "alpha-item1.webp")
  assert("项1: 落盘文件可取回且为 WebP", saved1.status === 200 && saved1.isWebp, saved1)
  await shot(page, "alpha-updated")

  // ============ 项 2：裁剪对话框取消 → 头像不变、无上传请求 ============
  const beta0 = s1.agents.find((a) => a.username === "qa-agent-beta").avatarUrl
  mark = reqLog.length
  await page.locator('input[aria-label="为 qa-agent-beta 选择头像"]').setInputFiles("/tmp/qa205/images/qa-b.png")
  await dialog.waitFor({ state: "visible", timeout: 10000 })
  await cropBox.waitFor({ state: "visible", timeout: 10000 })
  await shot(page, "beta-crop-open")
  await dialog.getByRole("button", { name: "取消" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 5000 })
  await page.waitForTimeout(1000)
  const cancelMuts = avatarMutationsSince(mark)
  assert("项2: 取消后无任何头像上传/删除请求", cancelMuts.length === 0, cancelMuts)
  const s2 = await snapState("after-item2-cancel")
  const beta2 = s2.agents.find((a) => a.username === "qa-agent-beta")
  assert("项2: beta 头像不变（仍为 null）", beta2.avatarUrl === beta0 && beta2.avatarUrl === null, beta2.avatarUrl)
  assert("项2: beta 行无头像 img", (await page.locator("li").filter({ hasText: "qa-agent-beta" }).locator("img[alt='qa-agent-beta']").count()) === 0)
  await shot(page, "beta-cancelled-unchanged")

  // ============ 项 3：多 agent 隔离（beta 上传，alpha 不动） ============
  mark = reqLog.length
  await page.locator('input[aria-label="为 qa-agent-beta 选择头像"]').setInputFiles("/tmp/qa205/images/qa-b.png")
  await dialog.waitFor({ state: "visible", timeout: 10000 })
  await cropBox.waitFor({ state: "visible", timeout: 10000 })
  await shot(page, "beta-crop-open-again")
  await dialog.getByRole("button", { name: "确定" }).click()
  await page.getByRole("status").getByText("Agent 头像已更新。").waitFor({ timeout: 15000 })
  const betaRow = page.locator("li").filter({ hasText: "qa-agent-beta" })
  await betaRow.locator("img[alt='qa-agent-beta']").waitFor({ timeout: 10000 })
  const muts3 = avatarMutationsSince(mark)
  assert("项3: 仅 1 次上传且指向 beta", muts3.length === 1 && muts3[0].path === "/api/me/agents/3/avatar", muts3)
  const s3 = await snapState("after-item3")
  const a3 = s3.agents.find((a) => a.username === "qa-agent-alpha")
  const b3 = s3.agents.find((a) => a.username === "qa-agent-beta")
  assert("项3: beta.avatarUrl 已更新", typeof b3.avatarUrl === "string" && /\/api\/files\/avatars\//.test(b3.avatarUrl), b3.avatarUrl)
  assert("项3: alpha.avatarUrl 保持不变", a3.avatarUrl === alpha1.avatarUrl, { before: alpha1.avatarUrl, after: a3.avatarUrl })
  const savedBeta = await saveAvatarFile(b3.avatarUrl, "beta-item3.webp")
  assert("项3: beta 落盘文件为 WebP", savedBeta.status === 200 && savedBeta.isWebp, savedBeta)
  await shot(page, "beta-uploaded-alpha-unchanged")

  // ============ 项 4a：解码失败 → 错误提示、不上传 ============
  mark = reqLog.length
  await inAlpha.setInputFiles("/tmp/qa205/images/qa-bad.png")
  const errAlert = page.locator('p[role="alert"]').filter({ hasText: "图片解码失败" })
  await errAlert.waitFor({ state: "visible", timeout: 10000 })
  assert("项4a: 出现解码失败错误提示", await errAlert.isVisible())
  await dialog.waitFor({ state: "hidden", timeout: 5000 })
  assert("项4a: 对话框已关闭", (await dialog.count()) === 0 || !(await dialog.isVisible()))
  const muts4a = avatarMutationsSince(mark)
  assert("项4a: 无上传请求", muts4a.length === 0, muts4a)
  const s4 = await snapState("after-item4a")
  assert("项4a: alpha 头像不变", s4.agents.find((a) => a.username === "qa-agent-alpha").avatarUrl === alpha1.avatarUrl)
  await shot(page, "decode-failed-error")

  // ============ 项 4b：删除头像（alpha） ============
  mark = reqLog.length
  await alphaRow.getByRole("button", { name: "删除头像" }).click()
  await page.getByRole("status").getByText("Agent 头像已删除。").waitFor({ timeout: 15000 })
  const delRes = responsesSince(mark, /^\/api\/me\/agents\/2\/avatar$/)
  assert("项4b: DELETE 请求 200", delRes.some((r) => r.method === "DELETE" && r.status === 200), delRes)
  const s5 = await snapState("after-item4b")
  const a5 = s5.agents.find((a) => a.username === "qa-agent-alpha")
  const b5 = s5.agents.find((a) => a.username === "qa-agent-beta")
  assert("项4b: alpha.avatarUrl 置空", a5.avatarUrl === null, a5.avatarUrl)
  assert("项4b: beta 头像不受影响", b5.avatarUrl === b3.avatarUrl, { before: b3.avatarUrl, after: b5.avatarUrl })
  assert("项4b: alpha 行头像 img 移除", (await alphaRow.locator("img[alt='qa-agent-alpha']").count()) === 0)
  assert("项4b: 删除后『删除头像』按钮消失", (await alphaRow.getByRole("button", { name: "删除头像" }).count()) === 0)
  await shot(page, "alpha-avatar-deleted")

  // ============ 项 5：资料页自己换头像（回归） ============
  await page.goto(BASE + "/profile")
  await page.locator('input[aria-label="选择头像"]').waitFor({ timeout: 15000 })
  const me0 = (await snapState("profile-before")).me
  assert("项5: 资料页初始无头像", me0.avatarUrl === null, me0.avatarUrl)
  mark = reqLog.length
  await page.locator('input[aria-label="选择头像"]').setInputFiles("/tmp/qa205/images/qa-c.png")
  await dialog.waitFor({ state: "visible", timeout: 10000 })
  await cropBox.waitFor({ state: "visible", timeout: 10000 })
  await shot(page, "profile-crop-open")
  await dialog.getByRole("button", { name: "确定" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 5000 })
  // 预览阶段：保存按钮出现，但尚未上传
  const saveBtn = page.getByRole("button", { name: "保存", exact: true })
  await saveBtn.waitFor({ state: "visible", timeout: 10000 })
  const mutsPreview = avatarMutationsSince(mark)
  assert("项5: 裁剪确认后仅本地预览、未上传", mutsPreview.length === 0, mutsPreview)
  await shot(page, "profile-preview-no-upload")
  mark2 = reqLog.length
  await saveBtn.click()
  await page.getByRole("status").waitFor({ timeout: 15000 })
  const statusText = await page.locator('p[role="status"]').first().textContent()
  console.log("PROFILE STATUS TEXT: " + statusText)
  const muts5 = avatarMutationsSince(mark2)
  assert("项5: 点保存后恰好 1 次 POST /api/me/avatar", muts5.length === 1 && muts5[0].method === "POST" && muts5[0].path === "/api/me/avatar", muts5)
  const me1 = (await snapState("profile-after")).me
  assert("项5: 自己头像已更新", typeof me1.avatarUrl === "string" && /\/api\/files\/avatars\//.test(me1.avatarUrl), me1.avatarUrl)
  const savedMe = await saveAvatarFile(me1.avatarUrl, "profile-item5.webp")
  assert("项5: 落盘文件为 WebP", savedMe.status === 200 && savedMe.isWebp, savedMe)
  await shot(page, "profile-saved")

  // ============ 收尾 ============
  fs.writeFileSync(
    path.join(EV, "metrics.json"),
    JSON.stringify(
      {
        base: BASE,
        startedAt: stateTimeline[0]?.ts,
        finishedAt: new Date().toISOString(),
        results,
        shots,
        stateTimeline,
        requests: reqLog,
        savedFiles: { alpha1: "files/alpha-item1.webp", beta3: "files/beta-item3.webp", profile: "files/profile-item5.webp" }
      },
      null,
      2
    )
  )
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  if (failed.length) {
    console.log("FAILED:")
    for (const f of failed) console.log(" - " + f.name + " | " + JSON.stringify(f.detail))
  }
  await browser.close()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error("SCRIPT ERROR:", e)
  fs.writeFileSync(path.join(EV, "metrics.json"), JSON.stringify({ results, reqLog, stateTimeline, shots, fatal: String(e && e.stack || e) }, null, 2))
  process.exit(2)
})
