/**
 * 导出 PWA 图标（对齐模板规格）：基于 favicon.svg 渲染并导出四枚 PNG，
 * 随仓提交到 web/public/icons/。
 *
 * 几何与颜色源文件：web/public/icons/favicon.svg
 * 目标：
 * - pwa-192.png (192x192)
 * - pwa-512.png (512x512)
 * - pwa-maskable-512.png (512x512)
 * - apple-touch-icon.png (180x180)
 *
 * 图标变更后重跑 `node scripts/export-pwa-icons.mjs` 并提交新 PNG。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Resvg } from "@resvg/resvg-js"

const ROOT = path.resolve(import.meta.dirname, "..")
const OUT_DIR = path.resolve(ROOT, "web/public/icons")
const SVG_PATH = existsSync(path.join(OUT_DIR, "favicon.svg"))
  ? path.join(OUT_DIR, "favicon.svg")
  : path.join(ROOT, "web/public/favicon.svg")

const TARGETS = [
  ["pwa-192.png", 192],
  ["pwa-512.png", 512],
  ["pwa-maskable-512.png", 512],
  ["apple-touch-icon.png", 180]
]

const svg = readFileSync(SVG_PATH, "utf-8")
mkdirSync(OUT_DIR, { recursive: true })

for (const [name, size] of TARGETS) {
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: size
    }
  })
  const pngData = resvg.render()
  const pngBuffer = pngData.asPng()
  const outPath = path.join(OUT_DIR, name)
  writeFileSync(outPath, pngBuffer)
  console.log(
    `生成 ${name}（${size}x${size}，${(pngBuffer.length / 1024).toFixed(1)} KB）`
  )
}
