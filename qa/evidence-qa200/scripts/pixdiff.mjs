import fs from "node:fs"
import { PNG } from "pngjs"
const [aPath, bPath] = process.argv.slice(2)
const a = PNG.sync.read(fs.readFileSync(aPath))
const b = PNG.sync.read(fs.readFileSync(bPath))
if (a.width !== b.width || a.height !== b.height) {
  console.log(`尺寸不同: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  process.exit(0)
}
let diff = 0, rows = new Set(), cols = new Set()
for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) << 2
    if (Math.abs(a.data[i]-b.data[i]) > 8 || Math.abs(a.data[i+1]-b.data[i+1]) > 8 || Math.abs(a.data[i+2]-b.data[i+2]) > 8) {
      diff++; rows.add(y); cols.add(x)
    }
  }
}
const pct = ((diff / (a.width * a.height)) * 100).toFixed(3)
console.log(`${aPath.split("/").pop()} vs ${bPath.split("/").pop()}: ${a.width}x${a.height} 差异像素 ${diff} (${pct}%)`)
if (rows.size) {
  const rArr = [...rows].sort((x,y)=>x-y)
  console.log(`  差异行范围: ${rArr[0]}–${rArr[rArr.length-1]}, 差异列范围: ${Math.min(...cols)}–${Math.max(...cols)}`)
}
