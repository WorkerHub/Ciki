// 部署前置：把仓库/组织级配置翻成两样东西——
//   1. $RUNNER_TEMP/secrets.json（0600），交给 `wrangler deploy --secrets-file`
//   2. 已解析的 worker/wrangler.toml（占位符替换 + 注入 [vars] TABLE_PREFIX）
//
// 规则（规格 §7）：真实值只来自 GitHub Actions 的 secrets / vars，绝不进仓库、
// 绝不打印；任何一键缺失或仍是占位值，立即中止并点名是哪一把——绝不用空值或
// 占位值顶替。CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID 走
// secrets（GitHub 自动掩码，无需 add-mask），D1_DATABASE_NAME 保持 Variable 明文。
//
// 写入顺序：先把两样东西在内存里算好并校验完（含 wrangler.toml 的占位符残留
// 检查），再落盘——任何一处不合格都不留半成品。
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isUsablePrefix, resolveForCi } from "./resolve-table-prefix.mjs"

if (!process.env.RUNNER_TEMP) {
  console.error("RUNNER_TEMP is not set")
  process.exit(1)
}

/**
 * 占位值判定：`*_PLACEHOLDER` 后缀，以及仓库模板里出现过的 `replace-with-…`
 * 写法。模板值一旦被原样粘进 Secrets，必须和"没填"同等对待——否则会用公开
 * 已知的密钥上线。
 */
const isPlaceholder = (value) => {
  const v = value.trim()
  return /_PLACEHOLDER$/.test(v) || /^replace-with/i.test(v)
}

/** 必填项：键名 → 缺失时的提示位置。 */
const REQUIRED = [
  ["JWT_SECRET", "repository secret"],
  ["SETUP_SECRET", "repository secret"],
  ["CLOUDFLARE_API_TOKEN", "organization secret"],
  ["CLOUDFLARE_ACCOUNT_ID", "organization secret"],
  ["D1_DATABASE_ID", "organization secret"],
  ["D1_DATABASE_NAME", "organization variable"]
]

/** 只上传 Worker 运行时要用的密钥；资源 ID 只用于部署期的 wrangler 配置。 */
const SECRET_KEYS = ["JWT_SECRET", "SETUP_SECRET"]

const config = {}
const problems = []
for (const [name, where] of REQUIRED) {
  const raw = process.env[name]
  const value = typeof raw === "string" ? raw.trim() : ""
  if (value === "") {
    problems.push(`${name} 未配置（应放在 ${where}）`)
    continue
  }
  if (isPlaceholder(value)) {
    problems.push(`${name} 仍是占位值（应放在 ${where}）`)
    continue
  }
  config[name] = value
}
if (problems.length > 0) {
  for (const line of problems) console.error(line)
  console.error(
    "配置不全，已中止：不会生成 secrets.json，也不会改动 wrangler.toml。"
  )
  process.exit(1)
}

// ─── 1. TABLE_PREFIX 三态 ───────────────────────────────────────────────────
const tablePrefix = resolveForCi(process.env.TABLE_PREFIX)
if (!isUsablePrefix(tablePrefix)) {
  console.error(
    `TABLE_PREFIX 非法（空值表示无前缀；非空时须以字母或下划线开头，其后只允许字母、数字、下划线）：${JSON.stringify(tablePrefix)}。请修正 GitHub Variables 中的 TABLE_PREFIX。`
  )
  console.error("已中止：不会生成 secrets.json，也不会改动 wrangler.toml。")
  process.exit(1)
}

// ─── 2. wrangler.toml 占位符替换（仍在内存里，先不落盘）────────────────────
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
    "wrangler.toml 仍残留未替换的占位符，已中止：不会生成 secrets.json，也不会部署。"
  )
  process.exit(1)
}

// ─── 3. 落盘：secrets.json（0600）+ wrangler.toml ───────────────────────────
const secrets = {}
for (const key of SECRET_KEYS) secrets[key] = config[key]

const secretsPath = `${process.env.RUNNER_TEMP}/secrets.json`
// mode 只在创建时生效，先删掉可能残留的旧文件，保证 0600 真正落实。
rmSync(secretsPath, { force: true })
writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 })
writeFileSync(wranglerPath, toml)

// 日志只暴露键名与非机密的表前缀，绝不打印任何密钥/资源 ID 的值。
console.log(
  `secrets.json 已写入（${SECRET_KEYS.length} 把：${SECRET_KEYS.join(", ")}，权限 0600）`
)
console.log(
  `wrangler.toml 已解析（已注入 account_id / D1 名称与 ID；TABLE_PREFIX=${JSON.stringify(tablePrefix)}）`
)
