import fs from "node:fs"
import { PNG } from "pngjs"
const [src, dst, x0, y0, x1, y1] = process.argv.slice(2).map((v,i)=> i<2 ? v : +v)
const img = PNG.sync.read(fs.readFileSync(src))
const w = x1-x0, h = y1-y0
const out = new PNG({ width: w, height: h })
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const si = ((y0+y) * img.width + (x0+x)) << 2
  const di = (y * w + x) << 2
  for (let k = 0; k < 4; k++) out.data[di+k] = img.data[si+k]
}
fs.writeFileSync(dst, PNG.sync.write(out))
