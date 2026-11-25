// Ciki #224：production 登录页 ciki-theme 非法值直写复核（Jim 真跑）
// 约束：只测 https://ciki.oneboy.app 登录页；不登录；不写任何线上数据；
//       localStorage 写入仅限本次验证，测毕恢复基线原状；不起本地栈；不测分支。
import { chromium } from "playwright-core"
import fs from "node:fs"

const BASE = "https://ciki.oneboy.app"
const OUT = "/tmp/ciki-qa-224/evidence"
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const results = []
const consoleErrors = [] // 全程 console error 留档

// react-router 8.5.1 默认错误边界结构：<h2>Unexpected Application Error!</h2>
const CRASH_H2 = 'h2:text-is("Unexpected Application Error!")'

// 每个用例的预期（按代码语义钉死，见 qa/report.md）：
// - 扁平格式（spec 字面写法）：内联脚本 parsed.state 不存在 → theme 整体判非法 → auto；store merge 无操作 → 默认 auto/nova
// - 包裹层格式（zustand 真实落盘/12-12 崩溃形态）：rehydrate 校验 → theme 回 auto 或保留合法 light
// 系统配色模拟 dark：auto 档解析为 dark（证明在 auto 上），light 保留档解析为 light（证明 light 未被吞）。
const CASES = [
  {
    id: "case1a",
    label: "①字段互换（spec 字面扁平格式）",
    value: JSON.stringify({ theme: "paper", style: "light" }),
    expect: { mode: "dark", btn: /Theme: Auto|主题：自动/ },
    note: "扁平格式非 zustand 落盘格式：theme 不可能保留，预期 auto"
  },
  {
    id: "case1b",
    label: "①字段互换（zustand 包裹层=真实落盘/崩溃形态）",
    value: JSON.stringify({ state: { theme: "paper", style: "light" }, version: 0 }),
    expect: { mode: "dark", btn: /Theme: Auto|主题：自动/ },
    note: "字段互换进入 rehydrate 校验：theme→auto、style→nova"
  },
  {
    id: "case2a",
    label: "②非法 style（spec 字面扁平格式）",
    value: JSON.stringify({ theme: "light", style: "paperx" }),
    expect: { mode: "dark", btn: /Theme: Auto|主题：自动/ },
    note: "扁平格式：theme=light 无法保留（解析语义如此），预期 auto+nova"
  },
  {
    id: "case2b",
    label: "②非法 style（zustand 包裹层=真实落盘形态）",
    value: JSON.stringify({ state: { theme: "light", style: "paperx" }, version: 0 }),
    expect: { mode: "light", btn: /Theme: Light|主题：浅色/ },
    note: "style→nova，theme=light 保留（dark 系统下仍解析 light 即为证）"
  },
  {
    id: "case3",
    label: "附项：非法 JSON 裸字符串",
    value: "paper",
    expect: { mode: "dark", btn: /Theme: Auto|主题：自动/ },
    note: "非 JSON：内联脚本 catch → auto；store getItem 抛错走 reject 分支 → 不崩"
  }
]

function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
  console.log(line)
  fs.appendFileSync(`${OUT}/run.log`, line + "\n")
}

async function settle(page) {
  // 等登录页渲染稳（未登录 → email/password 输入框 + AuthShell 页脚版本）
  await page.waitForSelector('input[type="email"], input[type="password"]', {
    timeout: 30000,
    state: "visible"
  })
  await page.waitForTimeout(1200) // 等 zustand rehydrate + applyTheme + i18n 落定
}

async function observe(page) {
  return page.evaluate(() => {
    const root = document.documentElement
    const btn = document.querySelector(
      'button[aria-label*="Theme" i], button[aria-label*="主题"], button[title*="Theme" i], button[title*="主题"]'
    )
    return {
      url: location.href,
      h2CrashCount: document.querySelectorAll("h2").length
        ? Array.from(document.querySelectorAll("h2")).filter(
            (h) => h.textContent === "Unexpected Application Error!"
          ).length
        : 0,
      emailInput: !!document.querySelector('input[type="email"], input[name="email" i]'),
      passwordInput: !!document.querySelector('input[type="password"]'),
      cycleBtnHint: btn ? (btn.getAttribute("aria-label") || btn.getAttribute("title")) : null,
      dataTheme: root.getAttribute("data-theme"),
      dataMode: root.getAttribute("data-mode"),
      darkClass: root.classList.contains("dark"),
      colorScheme: root.style.colorScheme || getComputedStyle(root).colorScheme,
      footer: document.querySelector("footer")?.textContent ?? null,
      cikiThemeRaw: localStorage.getItem("ciki-theme"),
      allKeys: Object.fromEntries(Object.entries(localStorage))
    }
  })
}

const main = async () => {
  log("# Ciki #224 production 直写复核", new Date().toISOString())
  log("# 被测：", BASE, "（production，未登录）")

  const context = await chromium.launchPersistentContext("/tmp/ciki-qa-224/profile", {
    headless: true,
    proxy: { server: "http://127.0.0.1:7890" }, // 本机出口走本地代理（与 curl/env 同路径）
    colorScheme: "dark", // 全程模拟深色系统：让 auto 与 light 的解析结果可区分
    locale: "en-US",
    viewport: { width: 1280, height: 800 }
  })
  const page = await context.newPage()
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push({ text: msg.text(), url: msg.location().url })
    }
  })
  page.on("pageerror", (err) => {
    consoleErrors.push({ text: `PAGEERROR: ${err.message}`, url: "pageerror" })
  })

  // ── 步骤 0：基线（原状快照） ──────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 })
  await settle(page)
  const baseline = await observe(page)
  const snapshot = baseline.allKeys // 原状 = 写入前全部键值
  await page.screenshot({ path: `${OUT}/step0-baseline.png`, fullPage: true })
  log("# 基线 localStorage：", snapshot)
  log("# 基线页脚：", baseline.footer, "| data-theme:", baseline.dataTheme, "| data-mode:", baseline.dataMode)
  record("step0", "基线访问（原状快照 + 渲染健全）", [
    { name: "登录页渲染（email 输入框）", ok: baseline.emailInput, got: baseline.emailInput },
    { name: "登录页渲染（password 输入框）", ok: baseline.passwordInput, got: baseline.passwordInput },
    { name: "无崩溃错误页（h2 精确匹配=0）", ok: baseline.h2CrashCount === 0, got: baseline.h2CrashCount },
    { name: "页脚版本指纹（格式 v1.0.0-<n>-<hash>）", ok: /v1\.0\.0-\d+-[0-9a-f]{7,}/.test(baseline.footer || ""), got: baseline.footer },
    { name: "ThemeCycleButton 存在", ok: !!baseline.cycleBtnHint, got: baseline.cycleBtnHint }
  ], { snapshot })

  // ── 用例循环：直写 → 刷新 → 断言 ─────────────────────────────────────
  for (const c of CASES) {
    log(`\n# ${c.id} ${c.label} | note: ${c.note}`)
    await page.evaluate((v) => localStorage.setItem("ciki-theme", v), c.value)
    const written = await page.evaluate(() => localStorage.getItem("ciki-theme"))
    log(`# 直写 ciki-theme = ${written}`)
    consoleErrors.length = 0
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 })
    await settle(page)
    const o = await observe(page)
    await page.screenshot({ path: `${OUT}/${c.id}.png`, fullPage: true })
    log(`# 观测：data-theme=${o.dataTheme} data-mode=${o.dataMode} dark=${o.darkClass} btn=${o.cycleBtnHint}`)
    log(`# 刷新后 localStorage 原样：${o.cikiThemeRaw}`)
    const errs = consoleErrors.slice()
    const isProbe = (e) =>
      e.text.includes("401") &&
      (e.url.includes("/api/me") ||
        e.url.includes("/api/auth/refresh") ||
        e.text.includes("/api/me") ||
        e.text.includes("/api/auth/refresh"))
    const suspicious = errs.filter((e) => !isProbe(e))
    record(c.id, c.label, [
      { name: "不崩：无错误页 h2「Unexpected Application Error!」", ok: o.h2CrashCount === 0, got: o.h2CrashCount },
      { name: "登录页仍渲染（email+password）", ok: o.emailInput && o.passwordInput, got: { email: o.emailInput, password: o.passwordInput } },
      { name: `data-theme=nova（style 回退 nova）`, ok: o.dataTheme === "nova", got: o.dataTheme },
      { name: `data-mode=${c.expect.mode}（${c.expect.mode === "dark" ? "auto 跟随 dark 系统" : "light 保留不被吞"}）`, ok: o.dataMode === c.expect.mode, got: o.dataMode },
      { name: `循环按钮安全渲染且标签匹配 ${c.expect.btn}`, ok: !!o.cycleBtnHint && c.expect.btn.test(o.cycleBtnHint), got: o.cycleBtnHint },
      { name: "无 pageerror / 无可疑 console error（401 /api/me 探活豁免）", ok: suspicious.length === 0, got: suspicious.length ? suspicious : errs.map((e) => e.text) },
      { name: "页脚版本指纹仍在（格式 v1.0.0-<n>-<hash>）", ok: /v1\.0\.0-\d+-[0-9a-f]{7,}/.test(o.footer || ""), got: o.footer }
    ], { written: written, afterReload: o.cikiThemeRaw, note: c.note })
  }

  // ── 清理：恢复基线原状 ────────────────────────────────────────────────
  log("\n# 清理：恢复写入前快照")
  await page.evaluate((snap) => {
    localStorage.clear()
    for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v)
  }, snapshot)
  const restoredNow = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
  log("# 清理后（刷新前）localStorage：", restoredNow)
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 })
  await settle(page)
  const after = await observe(page)
  await page.screenshot({ path: `${OUT}/final-cleanup.png`, fullPage: true })
  const sameSnapshot =
    JSON.stringify(restoredNow) === JSON.stringify(snapshot)
  const afterSame = JSON.stringify(after.allKeys) === JSON.stringify(snapshot)
  record("cleanup", "③清理：恢复 production 域 localStorage 原状", [
    { name: "恢复动作本身：逐键等于写入前快照（刷新前）", ok: sameSnapshot, got: { restored: restoredNow, baseline: snapshot } },
    { name: "刷新后其余键与基线一致（差异只可能来自应用自身写入）", ok: afterSame, got: { after: after.allKeys, baseline: snapshot } },
    { name: "ciki-theme 不存在（基线本无此键）", ok: after.cikiThemeRaw === (snapshot["ciki-theme"] ?? null), got: after.cikiThemeRaw },
    { name: "页面仍正常渲染", ok: after.emailInput && after.h2CrashCount === 0, got: { email: after.emailInput, crash: after.h2CrashCount } }
  ])

  await context.close()
}

function record(id, label, checks, extra = {}) {
  const pass = checks.every((c) => c.ok)
  results.push({ id, label, pass, checks, ...extra })
  log(`# ${id} => ${pass ? "PASS" : "FAIL"}`)
  for (const c of checks) log(`  [${c.ok ? "ok" : "FAIL"}] ${c.name} | got: ${JSON.stringify(c.got)}`)
}

main()
  .then(() => {
    fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), results, consoleErrors: undefined }, null, 2))
    const allPass = results.every((r) => r.pass)
    log(`\n# 总判：${allPass ? "ALL PASS" : "HAS FAIL"} (${results.filter((r) => r.pass).length}/${results.length})`)
    process.exit(allPass ? 0 : 1)
  })
  .catch((e) => {
    log("# RUNNER ERROR:", e.message, e.stack)
    fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), results, runnerError: e.message }, null, 2))
    process.exit(2)
  })
