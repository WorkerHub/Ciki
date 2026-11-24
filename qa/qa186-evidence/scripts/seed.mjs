/**
 * Ciki QA 种子脚本：对给定 base URL 建一套固定的验收数据。
 * 两个实例（新版 / 旧版）必须拿到完全一致的数据，便于像素级对照。
 *
 * 用法：node seed.mjs <baseUrl> <outJson>
 */
const BASE = process.argv[2]
const OUT = process.argv[3]
const ADMIN = { email: "qa-admin@example.test", password: process.env.QA_PASSWORD || "<set-me>" }
const USER2 = { email: "qa-reader@example.test", password: process.env.QA_PASSWORD || "<set-me>" }

// 画布预览图：用 resvg 把一段 SVG 渲染成真实可见的 PNG
async function renderPreviewPng() {
  const { Resvg } = await import(
    "/tmp/qa-new/node_modules/@resvg/resvg-js/index.js"
  )
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240">
  <rect width="480" height="240" fill="#ffffff"/>
  <rect x="30" y="40" width="200" height="120" rx="8" fill="#fae0d6" stroke="#e2705a" stroke-width="2"/>
  <text x="60" y="110" font-family="sans-serif" font-size="24" fill="#7c2717">canvas QA</text>
  <circle cx="330" cy="100" r="46" fill="#f3bcae" stroke="#d6624b" stroke-width="2"/>
  <path d="M300 160 L360 170 L390 150" stroke="#2a2b2f" stroke-width="3" fill="none"/>
</svg>`
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 480 } })
  return Buffer.from(resvg.render().asPng())
}

function cookieJar() {
  let jar = new Map()
  return {
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
    },
    absorb(res) {
      const raw = res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean)
      for (const line of raw) {
        const [pair] = line.split(";")
        const idx = pair.indexOf("=")
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
      }
    }
  }
}

async function call(jar, method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  const jarHeader = jar.header()
  if (jarHeader) headers.cookie = jarHeader
  let payload
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers["content-type"] = "application/json"
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: payload,
    redirect: "manual"
  })
  jar.absorb(res)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text.slice(0, 200)
  }
  return { status: res.status, json }
}

function pngBlob(buf) {
  return new Blob([buf], { type: "image/png" })
}

const main = async () => {
  const jar = cookieJar()

  // 1) 注册首个管理员
  let r = await call(jar, "POST", "/api/auth/register", {
    email: ADMIN.email,
    password: ADMIN.password,
    language: "zh"
  })
  const registerStatus = r.status

  // 2) 登录
  r = await call(jar, "POST", "/api/auth/login", {
    email: ADMIN.email,
    password: ADMIN.password
  })
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`)
  const me = await call(jar, "GET", "/api/me")
  const adminId = me.json?.user?.id ?? me.json?.id
  const adminUsername = me.json?.user?.username ?? me.json?.username

  // 2.5) 造一枚 write 令牌：导入接口只认 kind=write 令牌，不认会话
  const tok = await call(jar, "POST", "/api/me/tokens", { kind: "write", name: "qa-seed" })
  const writeToken = tok.json?.token ?? tok.json?.plaintextToken
  const writeAuth = { authorization: `Bearer ${writeToken}` }

  // 3) 管理员建第二个真人账号（评论作者 → 触发通知）
  const r2 = await call(jar, "POST", "/api/admin/users", {
    email: USER2.email,
    password: USER2.password,
    role: "user"
  })
  const user2Id = r2.json?.user?.id ?? r2.json?.id

  // 4) 上传资源：画布预览 PNG、画布场景 JSON、embed HTML
  const pngBytes = await renderPreviewPng()
  const fdPng = new FormData()
  fdPng.append("file", pngBlob(pngBytes), "preview.png")
  const upPng = await call(jar, "POST", "/api/files", fdPng)
  const previewKey = upPng.json?.key

  const scene = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      {
        id: "qa-rect-1",
        type: "rectangle",
        x: 40,
        y: 40,
        width: 220,
        height: 120,
        angle: 0,
        strokeColor: "#2a2b2f",
        backgroundColor: "#fae0d6",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: "a0",
        roundness: { type: 3 },
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false
      },
      {
        id: "qa-text-1",
        type: "text",
        x: 60,
        y: 80,
        width: 160,
        height: 24,
        angle: 0,
        strokeColor: "#7c2717",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: "a1",
        roundness: null,
        seed: 2,
        version: 1,
        versionNonce: 2,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        text: "画布 QA",
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        originalText: "画布 QA",
        lineHeight: 1.25,
        autoResize: true,
        lineWidth: 160
      }
    ],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {}
  }
  const fdScene = new FormData()
  fdScene.append(
    "file",
    new Blob([JSON.stringify(scene)], { type: "application/json" }),
    "scene.json"
  )
  const upScene = await call(jar, "POST", "/api/files", fdScene)
  const sceneKey = upScene.json?.key

  const embedHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Embed QA</title>
<style>body{margin:0;font-family:system-ui;background:#ffffff;color:#2a2b2f;padding:12px}
.box{border:1px solid #dfdbd2;border-radius:8px;padding:10px;background:#f9f7f2}</style>
</head><body><div class="box">Embed 块内容 · 中文与 English</div></body></html>`
  const fdEmbed = new FormData()
  fdEmbed.append("file", new Blob([embedHtml], { type: "text/html" }), "embed.html")
  const upEmbed = await call(jar, "POST", "/api/files/embeds", fdEmbed)
  const embedKey = upEmbed.json?.key

  // 5) 建页面：标题 + 中文正文 + 代码块 + 表格 + 画布块 + Embed 块
  const codeSample = [
    "import { readFile } from 'node:fs/promises'",
    "",
    "type Config = { name: string; retries: number }",
    "",
    "export async function load(path: string): Promise<Config> {",
    "  const raw = await readFile(path, 'utf8')",
    "  return JSON.parse(raw) as Config",
    "}"
  ].join("\n")
  const codeHtml = codeSample
    .split("\n")
    .map((l) => `<span class="hljs-keyword">${l}</span>`)
    .join("\n")

  const contentHtml = "" // 由 /api/import/pages 服务端渲染，这里不再手写 HTML

  const contentJson = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "纸面验收样例" }]
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "中文回退链验证：加粗中文、斜体中文、行内代码与 English text 混排。"
          }
        ]
      },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: codeSample }]
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "列一" }] }] },
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "列二" }] }] }
            ]
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "甲" }] }] },
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "乙" }] }] }
            ]
          }
        ]
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "无序项一（中文）" }] }
            ]
          },
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "无序项二 English item" }] }
            ]
          }
        ]
      },
      {
        type: "blockquote",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "引用段落：这是一段引文，用于检查引用块在纸面主题下的底色。" }] }
        ]
      },
      {
        type: "excalidraw",
        attrs: {
          sceneKey: sceneKey ?? "",
          previewKey: previewKey ?? "",
          extractedText: "画布 QA",
          width: 480
        }
      },
      {
        type: "htmlEmbed",
        attrs: { key: embedKey ?? "", height: 200, name: "embed-qa" }
      }
    ]
  })

  const created = await call(jar, "POST", "/api/write/pages", {
    title: "纸面验收样例",
    content_json: contentJson
  }, { headers: writeAuth })
  const pageId = created.json?.id

  // 6) 第二个用户登录并评论 → 触发管理员通知
  const jar2 = cookieJar()
  const login2 = await call(jar2, "POST", "/api/auth/login", {
    email: USER2.email,
    password: USER2.password
  })
  if (login2.status !== 200)
    throw new Error(`login2 failed: ${login2.status} ${JSON.stringify(login2.json)}`)
  const cmt = await call(jar2, "POST", `/api/pages/${pageId}/comments`, {
    bodyMd: "这是一条 QA 评论，用于检查评论区在纸面浅/暗下的观感。English comment too."
  })
  const reply = await call(jar2, "POST", `/api/pages/${pageId}/comments`, {
    bodyMd: "QA 回复：验证回复层级下的排版与气泡底色。",
    parentId: cmt.json?.id
  })

  // 7) 再建一个子页面（验证树/面包屑）
  const child = await call(jar, "POST", "/api/write/pages", {
    title: "纸面验收样例 · 子页",
    parent_id: pageId,
    content_json: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "子页面内容" }] }]
    })
  }, { headers: writeAuth })

  const result = {
    base: BASE,
    createdRaw: created.json,
    cmtRaw: cmt.json,
    replyRaw: reply.json,
    registerStatus,
    adminId,
    adminUsername,
    user2Id,
    pageId,
    childPageId: child.json?.id ?? null,
    commentId: cmt.json?.id ?? null,
    replyId: reply.json?.id ?? null,
    keys: { previewKey, sceneKey, embedKey },
    statuses: {
      upPng: upPng.status,
      upScene: upScene.status,
      upEmbed: upEmbed.status,
      created: created.status,
      cmt: cmt.status,
      reply: reply.status,
      child: child.status
    }
  }
  console.log(JSON.stringify(result, null, 2))
  if (OUT) {
    const fs = await import("node:fs")
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
  }
}

main().catch((e) => {
  console.error("SEED FAILED:", e.message)
  process.exit(1)
})
