import { chromium } from "playwright"
import fs from "node:fs"
const browser = await chromium.launch()
console.log("browser:", browser.version())
const p = await browser.newPage({ viewport: { width: 400, height: 400 } })
await p.setContent(`
<div id="A" style="margin:40px 0 0 60px; width:200px; height:40px; overflow-x:clip; overflow-clip-margin:4px; background:white;">
  <div style="width:200px; height:20px; box-shadow:0 0 0 3px red; background:#eee;"></div>
</div>
<div id="C" style="margin:20px 0 0 60px; width:200px; height:40px; overflow-x:clip; background:white;">
  <div style="width:200px; height:20px; box-shadow:0 0 0 3px red; background:#eee;"></div>
</div>
`)
await p.waitForTimeout(200)
const geo = await p.evaluate(() => {
  const g = (id) => {
    const b = document.getElementById(id).getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
  }
  return { A: g("A"), C: g("C") }
})
console.log("geo:", JSON.stringify(geo))
// 条带：容器左缘外 6px、容器高度中部（子元素阴影区）
const midA = { x: geo.A.left - 6, y: geo.A.top + 10, width: 6, height: 8 }
const midC = { x: geo.C.left - 6, y: geo.C.top + 10, width: 6, height: 8 }
const sA = await p.screenshot({ clip: midA })
const sC = await p.screenshot({ clip: midC })
fs.writeFileSync("/tmp/qa176/probe5-strip-A-withMargin.png", sA)
fs.writeFileSync("/tmp/qa176/probe5-strip-C-noMargin.png", sC)
console.log("stripA == stripC ?", sA.equals(sC))
// 再看 A 的左缘外侧 1~4px 是否有非白像素（红环）: 截宽 6 的条带，解码 PNG 看最左列
// 简化: 分别截 [left-4, left) 与 [left-8, left-4) 两段对比 A 与 C
for (const seg of [[-4, 0], [-8, -4], [-3, 0]]) {
  const a = await p.screenshot({ clip: { x: geo.A.left + seg[0], y: geo.A.top + 10, width: seg[1] - seg[0], height: 8 } })
  const c = await p.screenshot({ clip: { x: geo.C.left + seg[0], y: geo.C.top + 10, width: seg[1] - seg[0], height: 8 } })
  console.log(`seg[${seg[0]},${seg[1]}): A==C ? ${a.equals(c)}`)
}
await browser.close()
