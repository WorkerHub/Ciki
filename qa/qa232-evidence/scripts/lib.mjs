// QA #232 公共工具：浏览器启动、采样核心。改自首轮 qa229 lib.mjs（Chromium 1255 同机同法）。
// 本机 P3685.local：生产出网走 HTTPS_PROXY（本机 7890），localhost/127.0.0.1 必须绕过。

export function chromiumPath() {
  return `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
}

export function launchOptions() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890"
  return {
    headless: true,
    executablePath: chromiumPath(),
    proxy: { server: proxy, bypass: "127.0.0.1,localhost" }
  }
}

// 等待编辑器就绪：ProseMirror 挂载 + 标记文本可见 + 工具条触发器出现。
export async function waitForEditorReady(page, marker) {
  await page.waitForSelector(".ProseMirror", { state: "attached", timeout: 30000 })
  if (marker) {
    await page.waitForSelector(`.ProseMirror :text("${marker}")`, {
      state: "visible",
      timeout: 30000
    })
  }
  await page.waitForSelector('[aria-label="段落样式"]', {
    state: "visible",
    timeout: 30000
  })
}

// 读当前标签（单点）
export async function readLabel(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[aria-label="段落样式"]')
    if (!el) return null
    const sv = el.querySelector("[data-slot]")
    return (sv ?? el).textContent?.trim() ?? null
  })
}

// 采样核心（已就绪页面上用）：无任何交互，rAF 高频记录标签文本。
export async function sampleLabel(page, { windowMs = 2000 } = {}) {
  return page.evaluate(
    (win) =>
      new Promise((resolve) => {
        const trigger = () =>
          document.querySelector('[aria-label="段落样式"]')
        const readLabel = () => {
          const el = trigger()
          if (!el) return null
          const sv = el.querySelector("[data-slot]")
          return (sv ?? el).textContent?.trim() ?? null
        }
        const t0 = performance.now()
        const samples = []
        const tick = () => {
          const t = performance.now() - t0
          const label = readLabel()
          if (label !== null) samples.push({ t: Math.round(t), label })
          if (performance.now() - t0 < win) {
            requestAnimationFrame(tick)
          } else {
            const distinct = [...new Set(samples.map((s) => s.label))]
            resolve({
              samples,
              distinct,
              firstAt: samples[0]?.t ?? null,
              lastAt: samples[samples.length - 1]?.t ?? null
            })
          }
        }
        requestAnimationFrame(tick)
      }),
    windowMs
  )
}

// netscape cookie 文件 → playwright addCookies（含 #HttpOnly_ 前缀行，首轮踩过的坑）。
export function parseCookieFile(content, host) {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      let httpOnly = false
      if (l.startsWith("#HttpOnly_")) {
        httpOnly = true
        l = l.slice("#HttpOnly_".length)
      } else if (l.startsWith("#")) return null
      const p = l.split("\t")
      if (p.length < 7) return null
      return {
        name: p[5], value: p[6].trim(), domain: host, path: p[2] || "/",
        httpOnly, secure: p[3] === "TRUE", expires: Math.floor(Date.now() / 1000) + 3600
      }
    })
    .filter(Boolean)
}
