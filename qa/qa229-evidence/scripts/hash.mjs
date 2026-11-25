// PBKDF2-SHA256 口令哈希（Ciki 格式：saltHex:hashHex，100000 次，32B 盐 32B 输出）。
// 用法：node hash.mjs "<口令>"  → 输出哈希串（口令不回显）
import { webcrypto as crypto } from "node:crypto"

const password = process.argv[2]
if (!password) {
  console.error("usage: node hash.mjs <password>")
  process.exit(1)
}
const salt = crypto.getRandomValues(new Uint8Array(32))
const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveBits"]
)
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
  key,
  256
)
const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
console.log(`${hex(salt)}:${hex(bits)}`)
