// QA #229 公共工具：口令哈希、浏览器启动、采样核心。
// 红线：口令一律走环境变量 QA_PASSWORD，不落盘、不进日志。

export function chromiumPath() {
  return `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
}

// 生产站点出网走本机代理；localhost/127.0.0.1 必须绕过（Chromium 不认 no_proxy）。
export function launchOptions() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890"
  return {
    headless: true,
    executablePath: chromiumPath(),
    proxy: { server: proxy, bypass: "127.0.0.1,localhost" }
  }
}

// 采样核心：加载编辑页后，无任何交互，用 rAF 高频记录段落样式标签文本。
// 返回 {samples:[{t,label}], distinct:[...], firstAt, lastAt}
export async function sampleLabel(page, { windowMs = 2000 } = {}) {
  return page.evaluate(
    (win) =>
      new Promise((resolve) => {
        const trigger = () =>
          document.querySelector('[aria-label="段落样式"]')
        const readLabel = () => {
          const el = trigger()
          if (!el) return null
          const sv = el.querySelector("[data-slot]") // SelectValue 容器
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
