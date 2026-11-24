import fs from "node:fs"
import { launch } from "./lib.mjs"

/** 列出两图差异像素的连通簇（bbox + 两侧取样颜色）。 */
const [, , aFile, bFile] = process.argv
const browser = await launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
const page = await context.newPage()
const a = "data:image/png;base64," + fs.readFileSync(aFile).toString("base64")
const b = "data:image/png;base64," + fs.readFileSync(bFile).toString("base64")
const out = await page.evaluate(
  async ([a, b]) => {
    const load = (src) =>
      new Promise((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = rej
        i.src = src
      })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const px = (img) => {
      const c = document.createElement("canvas")
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext("2d")
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, img.width, img.height).data
    }
    const da = px(ia)
    const db = px(ib)
    const W = ia.width
    const H = ia.height
    const diff = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      const j = i * 4
      if (
        Math.abs(da[j] - db[j]) +
          Math.abs(da[j + 1] - db[j + 1]) +
          Math.abs(da[j + 2] - db[j + 2]) >
        0
      )
        diff[i] = 1
    }
    // 连通簇（8 邻域，迭代展开）
    const clusters = []
    const seen = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      if (!diff[i] || seen[i]) continue
      const stack = [i]
      seen[i] = 1
      let count = 0
      let minX = W,
        minY = H,
        maxX = -1,
        maxY = -1
      const samples = []
      while (stack.length) {
        const p = stack.pop()
        const x = p % W
        const y = (p - x) / W
        count++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (samples.length < 4) {
          const j = p * 4
          samples.push({
            x,
            y,
            a: `rgb(${da[j]},${da[j + 1]},${da[j + 2]})`,
            b: `rgb(${db[j]},${db[j + 1]},${db[j + 2]})`
          })
        }
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            const q = ny * W + nx
            if (diff[q] && !seen[q]) {
              seen[q] = 1
              stack.push(q)
            }
          }
        }
      }
      clusters.push({ count, bbox: { minX, minY, maxX, maxY }, samples })
    }
    clusters.sort((m, n) => n.count - m.count)
    return clusters.slice(0, 25)
  },
  [a, b]
)
console.log(JSON.stringify(out, null, 1))
await browser.close()
