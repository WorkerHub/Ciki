import fs from "node:fs"
import { launch, newContext, attachSession, goto, writeJson, SHOTS } from "./lib.mjs"

/**
 * 交互验收：
 *  1) 四种组合在设置页 UI 上均可达
 *  2) 刷新后设置保持（localStorage + 根属性 + .dark）
 *  3) 自动模式随系统明暗实时变化
 *  4) 顶栏快捷切换按钮循环并持久化
 */
const BASE = "http://127.0.0.1:9311"
const COOKIE = "/tmp/qa/cookies-new.json"
const browser = await launch()
const steps = []

function snap(page, label) {
  return page.evaluate((label) => {
    const root = document.documentElement
    return {
      label,
      dataTheme: root.getAttribute("data-theme"),
      dataMode: root.getAttribute("data-mode"),
      darkClass: root.classList.contains("dark"),
      colorScheme: root.style.colorScheme,
      metaThemeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      stored: localStorage.getItem("ciki-theme"),
      pressed: Object.fromEntries(
        ["Nova", "纸面", "自动", "浅色", "深色"].map((t) => {
          const b = [...document.querySelectorAll('[role="radio"]')].find(
            (x) => x.textContent.trim() === t
          )
          return [t, b ? b.getAttribute("aria-checked") : null]
        })
      )
    }
  }, label)
}

const context = await newContext(browser, { width: 1440, height: 900 })
await attachSession(context, COOKIE)
const page = await context.newPage()

// —— 0. 默认状态（不注入主题，模拟首次访问） ——
await goto(page, BASE, "/settings", 'h1')
await page.waitForTimeout(600)
steps.push({ step: "default", ...(await snap(page, "默认（首次访问）")) })

// —— 1. 通过 UI 切到「纸面」 ——
await page.getByRole("radio", { name: "纸面", exact: true }).click()
await page.waitForTimeout(400)
steps.push({ step: "ui-paper", ...(await snap(page, "设置页点击「纸面」")) })

// —— 2. 通过 UI 切到「深色」 ——
await page.getByRole("radio", { name: "深色", exact: true }).click()
await page.waitForTimeout(400)
steps.push({ step: "ui-dark", ...(await snap(page, "设置页点击「深色」")) })
await page.screenshot({ path: `${SHOTS}/interact/settings-paper-dark.png` })

// —— 3. 刷新后保持 ——
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForTimeout(900)
steps.push({ step: "after-reload", ...(await snap(page, "刷新后（纸面 + 深色）")) })
await page.screenshot({ path: `${SHOTS}/interact/after-reload.png` })

// —— 4. 回到「浅色」，刷新核对 ——
await page.getByRole("radio", { name: "浅色", exact: true }).click()
await page.waitForTimeout(400)
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForTimeout(900)
steps.push({ step: "paper-light-reload", ...(await snap(page, "刷新后（纸面 + 浅色）")) })

// —— 5. 切回 Nova，核对 ——
await page.getByRole("radio", { name: "Nova", exact: true }).click()
await page.waitForTimeout(400)
steps.push({ step: "ui-nova", ...(await snap(page, "设置页点击「Nova」")) })

// —— 6. 自动模式：跟随系统明暗 ——
await page.getByRole("radio", { name: "自动", exact: true }).click()
await page.waitForTimeout(400)
steps.push({ step: "auto-system-light", ...(await snap(page, "自动模式 + 系统浅色")) })
await page.emulateMedia({ colorScheme: "dark" })
await page.waitForTimeout(600)
steps.push({ step: "auto-system-dark", ...(await snap(page, "自动模式 + 系统切深色")) })
await page.screenshot({ path: `${SHOTS}/interact/auto-system-dark.png` })
await page.emulateMedia({ colorScheme: "light" })
await page.waitForTimeout(600)
steps.push({ step: "auto-system-light-again", ...(await snap(page, "自动模式 + 系统切回浅色")) })

// —— 7. 纸面 + 自动 + 系统深色 ——
await page.getByRole("radio", { name: "纸面", exact: true }).click()
await page.waitForTimeout(300)
await page.emulateMedia({ colorScheme: "dark" })
await page.waitForTimeout(600)
steps.push({ step: "paper-auto-system-dark", ...(await snap(page, "纸面 + 自动 + 系统深色")) })
await page.screenshot({ path: `${SHOTS}/interact/paper-auto-system-dark.png` })

// —— 8. 顶栏快捷切换按钮循环 ——
const cycle = page.getByRole("button", { name: /主题：/ }).filter({ visible: true }).first()
const cycleStates = []
for (let i = 0; i < 4; i++) {
  cycleStates.push(await snap(page, `顶栏循环前 ${i}`))
  await cycle.click()
  await page.waitForTimeout(400)
}
cycleStates.push(await snap(page, "顶栏循环后"))
steps.push({ step: "topbar-cycle", states: cycleStates })
await page.screenshot({ path: `${SHOTS}/interact/topbar-cycle.png` })

// —— 9. 刷新后顶栏循环的结果仍在 ——
await page.reload({ waitUntil: "domcontentloaded" })
await page.waitForTimeout(900)
steps.push({ step: "cycle-after-reload", ...(await snap(page, "顶栏循环后刷新")) })

writeJson("/tmp/qa/interact.json", steps)
console.log(JSON.stringify(steps, null, 1))
await browser.close()
