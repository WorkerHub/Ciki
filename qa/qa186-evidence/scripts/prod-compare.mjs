import fs from "node:fs"
import { launch, newContext, installTheme, writeJson, SHOTS } from "./lib.mjs"

/** 本地新版本 vs 生产站（Nova 浅/暗）：登录页像素 + 令牌对照 */
const NEW = "http://127.0.0.1:9311"
const PROD = "https://ciki.pama.workers.dev"

const browser = await launch()
const report = {}

async function shoot(base, style, mode) {
  const context = await newContext(browser, { width: 1440, height: 900 })
  await installTheme(context, style, mode)
  const page = await context.newPage()
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" })
  await page
    .waitForSelector('input[type="email"], input[name="email"], form', { timeout: 30000 })
    .catch(() => {})
  await page.waitForTimeout(1500)
  const buf = await page.screenshot()
  const info = await page.evaluate(() => {
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const body = getComputedStyle(document.body)
    const btn = document.querySelector('button[type="submit"]')
    return {
      url: location.pathname,
      dataTheme: root.getAttribute("data-theme"),
      dataMode: root.getAttribute("data-mode"),
      dark: root.classList.contains("dark"),
      bodyBg: body.backgroundColor,
      bodyFg: body.color,
      bodyFont: body.fontFamily,
      tokens: Object.fromEntries(
        [
          "--background",
          "--foreground",
          "--card",
          "--primary",
          "--primary-foreground",
          "--secondary",
          "--muted",
          "--muted-foreground",
          "--accent",
          "--border",
          "--ring",
          "--radius",
          "--font-sans-family",
          "--font-mono-family"
        ].map((n) => [n, cs.getPropertyValue(n).trim()])
      ),
      submitBtn: btn
        ? { bg: getComputedStyle(btn).backgroundColor, fg: getComputedStyle(btn).color, radius: getComputedStyle(btn).borderRadius }
        : null,
      footer: document.body.innerText.split("\n").slice(-3).join(" | ")
    }
  })
  await context.close()
  return { buf, info }
}

for (const combo of [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" }
]) {
  const key = `${combo.style}-${combo.mode}`
  const A = await shoot(NEW, combo.style, combo.mode)
  const B = await shoot(PROD, combo.style, combo.mode)
  fs.writeFileSync(`${SHOTS}/prod-${key}-local.png`, A.buf)
  fs.writeFileSync(`${SHOTS}/prod-${key}-prod.png`, B.buf)
  const tokenDiff = {}
  for (const k of Object.keys(A.info.tokens)) {
    if (A.info.tokens[k] !== B.info.tokens[k]) tokenDiff[k] = { local: A.info.tokens[k], prod: B.info.tokens[k] }
  }
  report[key] = {
    local: A.info,
    prod: B.info,
    identicalBytes: A.buf.equals(B.buf),
    tokenDiff
  }
  console.log(key, "identical:", A.buf.equals(B.buf), "tokenDiff:", JSON.stringify(tokenDiff))
}
writeJson("/tmp/qa/prod-compare.json", report)
await browser.close()
