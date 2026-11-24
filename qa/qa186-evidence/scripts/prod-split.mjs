import fs from "node:fs"
import { launch } from "./lib.mjs"

/** 把「登录卡片内容差异」与「主题渲染差异」分开：统计卡片外区域与卡片内区域各自的像素差 */
const browser = await launch()
const CARD = { minX: 527, maxX: 912, minY: 223, maxY: 880 }

async function split(a, b) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const r = await page.evaluate(
    async ([ab, bb, card]) => {
      const load = (s) =>
        new Promise((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = rej
          i.src = "data:image/png;base64," + s
        })
      const [ia, ib] = await Promise.all([load(ab), load(bb)])
      const cv = (img) => {
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const x = c.getContext("2d")
        x.drawImage(img, 0, 0)
        return x.getImageData(0, 0, img.width, img.height).data
      }
      const da = cv(ia), db = cv(ib)
      let inside = 0, outside = 0, outsideMax = 0, outsideSamples = []
      for (let y = 0; y < ia.height; y++)
        for (let x = 0; x < ia.width; x++) {
          const i = (y * ia.width + x) * 4
          const d = Math.max(
            Math.abs(da[i] - db[i]),
            Math.abs(da[i + 1] - db[i + 1]),
            Math.abs(da[i + 2] - db[i + 2])
          )
          const inCard = x >= card.minX && x <= card.maxX && y >= card.minY && y <= card.maxY
          if (d > 0) {
            if (inCard) inside++
            else {
              outside++
              if (d > outsideMax) outsideMax = d
              if (outsideSamples.length < 6)
                outsideSamples.push({ x, y, a: `rgb(${da[i]},${da[i + 1]},${da[i + 2]})`, b: `rgb(${db[i]},${db[i + 1]},${db[i + 2]})`, d })
            }
          }
        }
      return { inside, outside, outsideMax, outsideSamples, total: ia.width * ia.height }
    },
    [a.toString("base64"), b.toString("base64"), CARD]
  )
  await ctx.close()
  return r
}

for (const mode of ["light", "dark"]) {
  const a = fs.readFileSync(`/tmp/qa/shots/prodcmp-nova-${mode}-local.png`)
  const b = fs.readFileSync(`/tmp/qa/shots/prodcmp-nova-${mode}-prod.png`)
  const r = await split(a, b)
  console.log(
    `nova-${mode}: 卡片内差=${r.inside}px，卡片外差=${r.outside}px（最大通道差=${r.outsideMax}）`
  )
  if (r.outsideSamples.length) console.log("   卡片外样本:", JSON.stringify(r.outsideSamples))
}
await browser.close()
