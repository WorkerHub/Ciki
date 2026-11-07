// 部署前置：把仓库/组织级配置翻成两样东西——
//   1. $RUNNER_TEMP/secrets.json（0600），交给 `wrangler deploy --secrets-file`
//   2. 已解析的 worker/wrangler.toml（占位符替换 + 注入 [vars] TABLE_PREFIX）
//
// 规则（规格 §7）：真实值只来自 GitHub Actions 的 secrets / vars，绝不进仓库、
// 绝不打印；任何一键缺失或仍是占位值，立即中止并点名是哪一把——绝不用空值或
// 占位值顶替。CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID 走 secrets（GitHub 自动
// 掩码，无需 add-mask），D1_DATABASE_NAME 保持 Variable 明文。
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isUsablePrefix, resolveForCi } from "./resolve-table-prefix.mjs"

if (!process.env.RUNNER_TEMP) {
  console.error("RUNNER_TEMP is not set")
  process.exit(1)
}

const isPlaceholder = (value) => /_PLACEHOLDER$/.test(value.trim())

/** 必填项：键名 → 缺失时的提示位置。 */
const REQUIRED = [
  ["JWT_SECRET", "repository secret"],
  ["SETUP_SECRET", "repository secret"],
  ["CLOUDFLARE_ACCOUNT_ID", "organization secret"],
  ["D1_DATABASE_ID", "organization secret"],
  ["D1_DATABASE_NAME", "organization variable"]
]

const config = {}
const missing = []
for (const [name, where] of REQUIRED) {
  const raw = process.env[name]
  const value = typeof raw === "string" ? raw.trim() : ""
  if (value === "") {
    missing.push(`${name} 未配置（应放在 ${where}）`)
    continue
  }
  if (isPlaceholder(value)) {
    missing.push(`${name} 仍是占位值（应放在 ${where}）`)
    continue
  }
  config[name] = value
}
if (missing.length > 0) {
  for (const line of missing) console.error(line)
  console.error("配置不全，已中止：不会生成 secrets.json，也不会部署。")
  process.exit(1)
}

// ─── 1. TABLE_PREFIX 三态 ───────────────────────────────────────────────────
// 先算前缀再写文件：任何一处配置不合格都不留半成品（不生成 secrets.json，
// 也不改动 wrangler.toml）。
const tablePrefix = resolveForCi(process.env.TABLE_PREFIX)
if (!isUsablePrefix(tablePrefix)) {
  console.error(
    `TABLE_PREFIX 含非法字符（只允许字母、数字、下划线）：${JSON.stringify(tablePrefix)}。请修正 GitHub Variables 中的 TABLE_PREFIX。`
  )
  console.error("已中止：不会生成 secrets.json，也不会部署。")
  process.exit(1)
}

// ─── 2. secrets.json ────────────────────────────────────────────────────────
// 只上传 Worker 运行时要用的密钥；资源 ID 只用于部署期的 wrangler 配置。
const secrets = {
  JWT_SECRET: config.JWT_SECRET,
  SETUP_SECRET: config.SETUP_SECRET
}

const secretsPath = `${process.env.RUNNER_TEMP}/secrets.json`
// mode 只在创建时生效，先删掉可能残留的旧文件，保证 0600 真正落实。
rmSync(secretsPath, { force: true })
writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 })
console.log(
  `secrets.json 已写入（${Object.keys(secrets).length} 把：${Object.keys(secrets).join(", ")}，权限 0600）`
)

// ─── 3. wrangler.toml 占位符替换 ────────────────────────────────────────────
const wranglerPath = fileURLToPath(
  new URL("../worker/wrangler.toml", import.meta.url)
)
let toml = readFileSync(wranglerPath, "utf8")

const replacements = {
  CLOUDFLARE_ACCOUNT_ID_PLACEHOLDER: config.CLOUDFLARE_ACCOUNT_ID,
  D1_DATABASE_NAME_PLACEHOLDER: config.D1_DATABASE_NAME,
  D1_DATABASE_ID_PLACEHOLDER: config.D1_DATABASE_ID
}
for (const [placeholder, value] of Object.entries(replacements)) {
  toml = toml.replaceAll(placeholder, value)
}

// 本地重复跑本脚本时去掉上一次追加的 [vars]，避免叠加。
toml = toml.replace(/\n\[vars\]\nTABLE_PREFIX = .*\n?$/, "")
if (!toml.endsWith("\n")) toml += "\n"
toml += `\n[vars]\nTABLE_PREFIX = ${JSON.stringify(tablePrefix)}\n`

if (toml.includes("_PLACEHOLDER")) {
  console.error(
    "wrangler.toml 仍残留未替换的占位符，已中止：不会部署带占位值的配置。"
  )
  process.exit(1)
}

writeFileSync(wranglerPath, toml)
console.log(
  `wrangler.toml 已解析（account ${config.CLOUDFLARE_ACCOUNT_ID}、D1 ${config.D1_DATABASE_NAME}、TABLE_PREFIX=${JSON.stringify(tablePrefix)}）`
)
