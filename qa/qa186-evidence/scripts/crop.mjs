import fs from "node:fs"
import { launch } from "./lib.mjs"

/** 把多张 PNG 的同一区域上下拼接成对照图。 */
const [, , outPath, regionJson, ...files] = process.argv
const region = JSON.parse(regionJson) // {x,y,w,h}
const browser = await launch()
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await context.newPage()
const imgs = files.map((f) => ({
  name: f.split("/").pop(),
  data: "data:image/png;base64," + fs.readFileSync(f).toString("base64")
}))
const dataUrl = await page.evaluate(
  async ([imgs, region]) => {
    const load = (src) =>
      new Promise((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = rej
        i.src = src
      })
    const loaded = await Promise.all(imgs.map((im) => load(im.data)))
    const labelH = 16
    const c = document.createElement("canvas")
    c.width = region.w
    c.height = (region.h + labelH) * loaded.length
    const ctx = c.getContext("2d")
    ctx.fillStyle = "#444"
    ctx.fillRect(0, 0, c.width, c.height)
    for (let i = 0; i < loaded.length; i++) {
      const y = i * (region.h + labelH)
      ctx.fillStyle = "#ff0"
      ctx.font = "12px monospace"
      ctx.fillText(imgs[i].name, 2, y + 12)
      ctx.drawImage(
        loaded[i],
        region.x,
        region.y,
        region.w,
        region.h,
        0,
        y + labelH,
        region.w,
        region.h
      )
    }
    return c.toDataURL("image/png")
  },
  [imgs, region]
)
fs.writeFileSync(outPath, Buffer.from(dataUrl.split(",")[1], "base64"))
await browser.close()
console.log("wrote", outPath)
