import { chromium } from "playwright"
import fs from "node:fs"
const browser = await chromium.launch()

// ② overflow-y:hidden 变体（最小复现）
const p = await browser.newPage({ viewport: { width: 400, height: 400 } })
await p.setContent(`
<div id="E" style="margin:40px 0 0 60px; width:200px; height:40px; overflow-x:clip; overflow-y:hidden; overflow-clip-margin:4px; background:white;">
  <div style="width:200px; height:20px; box-shadow:0 0 0 3px red; background:#eee;"></div>
</div>
`)
await p.waitForTimeout(200)
const geo = await p.evaluate(() => {
  const b = document.getElementById("E").getBoundingClientRect()
  return { left: b.left, top: b.top }
})
const e1 = await p.screenshot({ clip: { x: geo.left - 4, y: geo.top + 10, width: 4, height: 8 } })
const e2 = await p.screenshot({ clip: { x: geo.left - 8, y: geo.top + 10, width: 4, height: 8 } })
const countRed = (buf) => new Promise(async (resolve) => {
  const pp = await browser.newPage()
  const r = await pp.evaluate(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64
    await img.decode()
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let red = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i+1] < 100 && d[i+2] < 100) red++
    return red
  }, buf.toString("base64"))
  await pp.close()
  resolve(r)
})
console.log("E(ox:clip,oy:hidden,+margin): [left-4,left) red px =", await countRed(e1), "; [left-8,left-4) red px =", await countRed(e2))

// ① app 级现场实验：修复页 (:8906) 画布 overflow 改双轴 clip，环应出现
const res = await fetch("http://127.0.0.1:8906/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "jim@example.com", password: "JimPass123!" })
})
const m = /ciki_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  storageState: { cookies: [{ name: "ciki_session", value: m[1], domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now()/1000)+86400, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }
})
const page = await ctx.newPage()
await page.goto("http://127.0.0.1:8906/p/1", { waitUntil: "domcontentloaded" })
await page.locator("h1").waitFor()
await page.waitForTimeout(1000)
await page.evaluate(() => { document.querySelector("#comments-heading").scrollIntoView({ block: "start" }) })
await page.waitForSelector("textarea[data-slot=textarea]")
await page.waitForTimeout(400)

const stripFn = () => page.evaluate(() => {
  const ta = document.querySelector('textarea[data-slot="textarea"]')
  const b = ta.getBoundingClientRect()
  return { l: b.left, r: b.right, y: b.top + b.height / 2 - 4 }
})

async function takeStrips(label) {
  const g = await stripFn()
  const u = { x: g.l - 6, y: g.y, width: 6, height: 8 }
  const uf = await page.screenshot({ clip: u })
  await page.evaluate(() => document.querySelector('textarea[data-slot="textarea"]').focus())
  await page.waitForTimeout(300)
  const fo = await page.screenshot({ clip: u })
  await page.evaluate(() => document.querySelector('textarea[data-slot="textarea"]').blur())
  await page.waitForTimeout(300)
  const same = uf.equals(fo)
  fs.writeFileSync(`/tmp/qa176/probe8-${label}-left-unfocused.png`, uf)
  fs.writeFileSync(`/tmp/qa176/probe8-${label}-left-focused.png`, fo)
  console.log(`${label}: 聚焦/未聚焦左条带相同=${same}（不同=环画出）`)
}

await takeStrips("before-clipX")           // 现状: overflow-x:clip —— 预期相同（环被裁）
await page.evaluate(() => {
  const c = document.querySelector("[data-page-canvas]")
  c.style.overflow = "clip"                // 双轴 clip, 保留 margin 4px
})
await page.waitForTimeout(300)
await takeStrips("after-bothClip")         // 双轴 clip —— 预期不同（环画出）

await ctx.close()
await browser.close()
