/**
 * 表格末列拖拽自测用的同源 mock：托管 web/dist，并把一页带四种表格的正文
 * 喂给编辑页；PUT 保存后记住 payload，阅读页拿到的是同一份 contentHtml。
 *   node mock-server.mjs <web/dist> [port]
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join } from "node:path"

const DIST = process.argv[2]
const PORT = Number(process.argv[3] || 8899)

const cell = (w, text) => ({
  type: "tableCell",
  attrs: { colspan: 1, rowspan: 1, colwidth: w ? [w] : null },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }]
})
const row = (cells) => ({ type: "tableRow", content: cells })
const table = (rows) => ({ type: "table", attrs: {}, content: rows })
const p = (text) => ({ type: "paragraph", content: [{ type: "text", text }] })
const filler = "列内容示例文本比较长一些"

const doc = {
  type: "doc",
  content: [
    p("A. 三列，总宽已达正文宽（317 × 3）"),
    table([
      row([cell(317, filler), cell(317, filler), cell(317, filler)]),
      row([cell(317, "a"), cell(317, "b"), cell(317, "c")])
    ]),
    p("B. 三列，总宽窄于正文宽（120 × 3）"),
    table([
      row([cell(120, "A"), cell(120, "B"), cell(120, "C")]),
      row([cell(120, "1"), cell(120, "2"), cell(120, "3")])
    ]),
    p("C. 三列，存宽超过正文宽（400 × 3，等同粘贴带列宽）"),
    table([
      row([cell(400, filler), cell(400, filler), cell(400, filler)]),
      row([cell(400, "a"), cell(400, "b"), cell(400, "c")])
    ]),
    p("D. 单列表格（恒满宽）"),
    table([row([cell(null, "单列表格内容")])])
  ]
}
const docJson = JSON.stringify(doc)

let saved = null
const page = () => ({
  id: 1,
  parentId: null,
  spaceId: 1,
  title: "表格末列拖拽自测",
  sortOrder: 0,
  contentHtml: saved?.contentHtml ?? "",
  contentText: saved?.contentText ?? "",
  contentMd: "",
  createdBy: 1,
  updatedBy: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z"
})

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
const readBody = (req) =>
  new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve(null)
      }
    })
  })

const TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".html": "text/html"
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const path = url.pathname
  if (path.startsWith("/api/")) {
    if (path === "/api/setup/state")
      return json(res, { initialized: true, enabled: true, needsAdmin: false })
    if (path === "/api/auth/config")
      return json(res, {
        registrationEnabled: true,
        registrationApprovalRequired: false,
        siteName: "Ciki 自测",
        emailConfigured: false
      })
    if (path === "/api/me")
      return json(res, {
        id: 1,
        email: "probe@example.com",
        role: "admin",
        username: "probe",
        avatarUrl: null,
        approvalStatus: "approved",
        createdAt: "2026-01-01T00:00:00Z",
        language: "zh",
        twofa: {
          totpEnabled: false,
          passkeyEnabled: false,
          passkeyCount: 0,
          emailOtpEnabled: false
        }
      })
    if (path === "/api/spaces")
      return json(res, [
        {
          id: 1,
          slug: "main",
          name: "主空间",
          description: "",
          myRole: "owner",
          isDefault: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z"
        }
      ])
    if (path === "/api/pages")
      return json(res, [
        {
          id: 1,
          parentId: null,
          title: "表格末列拖拽自测",
          sortOrder: 0,
          updatedAt: "2026-01-01T00:00:00Z",
          children: []
        }
      ])
    if (path === "/api/pages/1" && req.method === "GET")
      return json(res, {
        ...page(),
        ...(url.searchParams.get("format") === "json"
          ? { contentJson: saved?.contentJson ?? docJson }
          : {})
      })
    if (path === "/api/pages/1" && req.method === "PUT") {
      const body = await readBody(req)
      if (body) saved = body
      return json(res, page())
    }
    if (path === "/api/save-payload") return json(res, saved)
    return json(res, { code: "NOT_FOUND", message: `no mock ${path}` }, 404)
  }

  let file = join(DIST, path === "/" ? "index.html" : path)
  if (!existsSync(file) || !statSync(file).isFile())
    file = join(DIST, "index.html")
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] || "application/octet-stream"
  })
  res.end(readFileSync(file))
}).listen(PORT, () => console.log("mock on", PORT))
