import { chromium } from "/tmp/pw/node_modules/playwright/index.mjs"
import fs from "node:fs"

export const SHOTS = "/tmp/qa/shots"
fs.mkdirSync(SHOTS, { recursive: true })

export const ACCOUNTS = {
  admin: { email: "qa-admin@example.test", password: process.env.QA_PASSWORD || "<set-me>" },
  reader: { email: "qa-reader@example.test", password: process.env.QA_PASSWORD || "<set-me>" }
}

export async function launch(opts = {}) {
  return chromium.launch({
    headless: true,
    proxy: { server: "http://127.0.0.1:7890", bypass: "127.0.0.1,localhost" },
    args: ["--font-render-hinting=none", "--disable-lcd-text"],
    ...opts
  })
}

export async function newContext(browser, { width = 1440, height = 900, dsf = 1, mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dsf,
    isMobile: mobile,
    hasTouch: mobile,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    colorScheme: "light"
  })
  return context
}

/** 注入已有会话 Cookie（避免反复登录触发限流）。 */
export async function attachSession(context, file) {
  const cookies = JSON.parse(fs.readFileSync(file, "utf8"))
  await context.addCookies(cookies)
  return cookies
}

/** 用会话 Cookie 登录（走 API，浏览器上下文共享 cookie jar）。 */
export async function login(context, base, who = "admin") {
  const acc = ACCOUNTS[who]
  const res = await context.request.post(`${base}/api/auth/login`, {
    data: { email: acc.email, password: acc.password }
  })
  if (!res.ok()) throw new Error(`login ${who} failed: ${res.status()} ${await res.text()}`)
  const me = await context.request.get(`${base}/api/me`)
  if (!me.ok()) throw new Error(`/api/me failed: ${me.status()}`)
  return await me.json()
}

/** 在页面加载前写入主题存储（zustand persist 格式）。 */
export async function installTheme(context, style, mode) {
  await context.addInitScript(
    ([s, m]) => {
      window.localStorage.setItem(
        "ciki-theme",
        JSON.stringify({ state: { theme: m, style: s }, version: 0 })
      )
    },
    [style, mode]
  )
}

export async function readThemeState(context) {
  const page = await context.newPage()
  await page.goto("http://127.0.0.1:9311/", { waitUntil: "domcontentloaded" }).catch(() => {})
  const v = await page.evaluate(() => localStorage.getItem("ciki-theme"))
  await page.close()
  return v
}

export async function themeAttrs(page) {
  return await page.evaluate(() => {
    const root = document.documentElement
    return {
      dataTheme: root.getAttribute("data-theme"),
      dataMode: root.getAttribute("data-mode"),
      darkClass: root.classList.contains("dark"),
      colorScheme: root.style.colorScheme,
      metaThemeColor: document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      stored: localStorage.getItem("ciki-theme")
    }
  })
}

export async function goto(page, base, path, waitFor) {
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" })
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 })
  // 等一帧让主题属性落定
  await page.waitForTimeout(400)
}

export function log(...args) {
  console.log(...args)
}

export function writeJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2))
}
