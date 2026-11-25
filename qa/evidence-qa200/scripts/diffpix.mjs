import fs from "node:fs"
import { PNG } from "pngjs"
const [aPath, bPath, x0, y0, x1, y1] = process.argv.slice(2).map((v,i)=> i<2 ? v : +v)
const a = PNG.sync.read(fs.readFileSync(aPath))
const b = PNG.sync.read(fs.readFileSync(bPath))
let count = 0
const samples = []
for (let y = y0; y < y1; y++) {
  for (let x = x0; x < x1; x++) {
    const i = (y * a.width + x) << 2
    const da = Math.abs(a.data[i]-b.data[i]) + Math.abs(a.data[i+1]-b.data[i+1]) + Math.abs(a.data[i+2]-b.data[i+2])
    if (da > 24) {
      count++
      if (samples.length < 12) samples.push({x, y, a:[a.data[i],a.data[i+1],a.data[i+2]], b:[b.data[i],b.data[i+1],b.data[i+2]]})
    }
  }
}
console.log("diff px:", count)
for (const s of samples) console.log(JSON.stringify(s))
