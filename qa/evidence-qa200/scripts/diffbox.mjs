import fs from "node:fs"
import { PNG } from "pngjs"
const [aPath, bPath] = process.argv.slice(2)
const a = PNG.sync.read(fs.readFileSync(aPath))
const b = PNG.sync.read(fs.readFileSync(bPath))
// 收集差异像素并按 16px 网格聚类输出矩形
const cells = new Map()
for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) << 2
    if (Math.abs(a.data[i]-b.data[i]) > 8 || Math.abs(a.data[i+1]-b.data[i+1]) > 8 || Math.abs(a.data[i+2]-b.data[i+2]) > 8) {
      const k = `${Math.floor(x/32)},${Math.floor(y/32)}`
      cells.set(k, (cells.get(k)||0)+1)
    }
  }
}
// 合并相邻 cell 为矩形（简单：按行分组输出范围）
const byRow = new Map()
for (const [k, n] of cells) {
  const [cx, cy] = k.split(",").map(Number)
  if (!byRow.has(cy)) byRow.set(cy, [])
  byRow.get(cy).push([cx, n])
}
for (const [cy, list] of [...byRow.entries()].sort((x,y)=>x[0]-y[0])) {
  list.sort((p,q)=>p[0]-q[0])
  console.log(`y=${cy*32}–${cy*32+31}: x cells ${list.map(([cx,n])=>`${cx*32}(${n})`).join(", ")}`)
}
