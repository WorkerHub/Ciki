/**
 * 生成三个验收用上传物（只作验收用，测完即删）：
 *   embed.html  —— Embed 嵌入 HTML（含中文、非 ASCII、body 标签）
 *   image.png   —— 合法 PNG（魔数可识别）
 *   scene.json  —— Excalidraw 场景 JSON（含会被消毒剥掉的字段，用于验证落盘对象 = 消毒后字节）
 */
const fs = require("node:fs")
const zlib = require("node:zlib")
const crypto = require("node:crypto")

const dir = "/tmp/qa243/art"
const nonce = crypto.randomBytes(6).toString("hex")

// --- embed.html ---
const embedHtml = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>QA243 embed ${nonce}</title></head>
<body style="margin:0">
<h1>QA243-EMBED-${nonce}</h1>
<p>中文校验：验收专用嵌入片段，逐字节比对用。</p>
<p>ASCII check: abcdefghijklmnopqrstuvwxyz0123456789</p>
<script>window.__QA243__="${nonce}";</script>
</body>
</html>
`
fs.writeFileSync(`${dir}/embed.html`, Buffer.from(embedHtml, "utf8"))

// --- image.png：4x4 纯色 PNG ---
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}
const W = 4
const H = 4
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // truecolor
const raw = []
for (let y = 0; y < H; y++) {
  raw.push(Buffer.from([0])) // filter none
  for (let x = 0; x < W; x++) raw.push(Buffer.from([0x1f, 0x6f, 0xeb]))
}
const idat = zlib.deflateSync(Buffer.concat(raw))
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0))
])
fs.writeFileSync(`${dir}/image.png`, png)

// --- scene.json：含会被剥掉的字段（customData / 未知元素类型 / 非法 link / appState 杂项）---
const scene = {
  type: "excalidraw",
  version: 2,
  source: `qa243-${nonce}`,
  elements: [
    {
      id: "qa243-rect-1",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 120,
      height: 60,
      strokeColor: "#1e1e1e",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
      link: "https://example.com/qa243",
      customData: { secret: "should-be-stripped" },
      __proto__: { polluted: true }
    },
    {
      id: "qa243-text-1",
      type: "text",
      x: 12,
      y: 40,
      width: 100,
      height: 20,
      text: `QA243 SCENE ${nonce}`,
      fontSize: 20,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top"
    },
    { id: "qa243-embed-1", type: "embeddable", x: 0, y: 0, width: 1, height: 1 }
  ],
  appState: {
    viewBackgroundColor: "#FFFFFF",
    gridSize: 20,
    exportWithDarkMode: false,
    exportBackground: true,
    exportPadding: 12,
    zoom: { value: 1.3 },
    theme: "dark"
  },
  files: { "img-1": { mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" } },
  unknownTopLevel: { drop: true }
}
fs.writeFileSync(`${dir}/scene.json`, Buffer.from(JSON.stringify(scene, null, 2), "utf8"))

fs.writeFileSync(
  `${dir}/nonce.txt`,
  nonce
)
console.log("nonce:", nonce)
console.log("embed.html", fs.statSync(`${dir}/embed.html`).size)
console.log("image.png", fs.statSync(`${dir}/image.png`).size)
console.log("scene.json", fs.statSync(`${dir}/scene.json`).size)
