import { chromium } from "playwright"
import fs from "node:fs"
const browser = await chromium.launch()
const p = await browser.newPage()
const files = [
  "probe5-strip-A-withMargin.png",   // overflow-x:clip + margin —— 期望红
  "probe5-strip-C-noMargin.png",     // overflow-x:clip 无 margin —— 对照（应无红）
  "probe6-B-inner.png",              // overflow:clip 双轴 + margin [left-4,left) —— 期望红
  "probe6-B-outer.png"               // [left-8,left-4) —— 期望白
]
for (const f of files) {
  const b64 = fs.readFileSync(`/tmp/qa176/${f}`).toString("base64")
  const info = await p.evaluate(async (b64) => {
    const img = new Image()
    img.src = "data:image/png;base64," + b64
    await img.decode()
    const c = document.createElement("canvas")
    c.width = img.width; c.height = img.height
    const ctx = c.getContext("2d")
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let red = 0, white = 0, other = 0
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i+1], d[i+2]]
      if (r > 150 && g < 100 && b < 100) red++
      else if (r > 240 && g > 240 && b > 240) white++
      else other++
    }
    return { w: c.width, h: c.height, red, white, other }
  }, b64)
  console.log(`${f}: ${JSON.stringify(info)}`)
}
await browser.close()
