import fs from "node:fs"
import { PNG } from "pngjs"
const [src, dst] = process.argv.slice(2)
const img = PNG.sync.read(fs.readFileSync(src))
const out = new PNG({ width: img.width*3, height: img.height*3 })
for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
  const si = (y * img.width + x) << 2
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
    const di = ((y*3+dy) * out.width + (x*3+dx)) << 2
    for (let k = 0; k < 4; k++) out.data[di+k] = img.data[si+k]
  }
}
fs.writeFileSync(dst, PNG.sync.write(out))
