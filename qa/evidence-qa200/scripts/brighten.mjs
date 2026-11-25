import fs from "node:fs"
import { PNG } from "pngjs"
const [src, dst] = process.argv.slice(2)
const img = PNG.sync.read(fs.readFileSync(src))
for (let i = 0; i < img.data.length; i += 4) {
  for (let k = 0; k < 3; k++) img.data[i+k] = Math.min(255, img.data[i+k] * 4)
}
fs.writeFileSync(dst, PNG.sync.write(img))
