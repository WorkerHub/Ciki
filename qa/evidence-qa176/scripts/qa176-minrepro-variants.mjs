import { chromium } from "playwright"
import fs from "node:fs"
const browser = await chromium.launch()
const p = await browser.newPage({ viewport: { width: 400, height: 500 } })
await p.setContent(`
<div id="B" style="margin:40px 0 0 60px; width:200px; height:40px; overflow:clip; overflow-clip-margin:4px; background:white;">
  <div style="width:200px; height:20px; box-shadow:0 0 0 3px red; background:#eee;"></div>
</div>
<div id="D" style="margin:20px 0 0 60px; width:200px; height:40px; overflow-x:clip; overflow-y:visible; overflow-clip-margin-left:4px; overflow-clip-margin-right:4px; background:white;">
  <div style="width:200px; height:20px; box-shadow:0 0 0 3px red; background:#eee;"></div>
</div>
`)
await p.waitForTimeout(200)
const geo = await p.evaluate(() => {
  const g = (id) => {
    const el = document.getElementById(id)
    const b = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { left: b.left, top: b.top, ox: cs.overflowX, oy: cs.overflowY, m: cs.overflowClipMargin, ml: cs.overflowClipMarginLeft ?? "n/a" }
  }
  return { B: g("B"), D: g("D") }
})
console.log("geo:", JSON.stringify(geo))
for (const id of ["B", "D"]) {
  const a = await p.screenshot({ clip: { x: geo[id].left - 4, y: geo[id].top + 10, width: 4, height: 8 } })
  const c = await p.screenshot({ clip: { x: geo[id].left - 8, y: geo[id].top + 10, width: 4, height: 8 } })
  fs.writeFileSync(`/tmp/qa176/probe6-${id}-inner.png`, a)
  fs.writeFileSync(`/tmp/qa176/probe6-${id}-outer.png`, c)
  // 有 margin 生效 => [left-4, left) 有红像素（阴影）；否则白色
  const buf = a
  console.log(`${id}: inner4px strip size=${buf.length}`)
}
console.log("（对比基线做法：直接看图）")
await browser.close()
