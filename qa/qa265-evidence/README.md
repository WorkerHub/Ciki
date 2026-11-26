# QA265 证据索引（生产验收：空间设置 slug 编辑）

验收报告：[`../qa265-report.md`](../qa265-report.md)。生产站点 `https://ciki.oneboy.app`，首轮实测版本 `v1.0.0-320-bcdac31`（含 PR #305 服务端 slug 写入、PR #306 前端 slug 编辑），返修复验实测版本 `v1.0.0-321-2cc27e1`（含 PR #308 返修：移除 slug 输入框 `maxLength`）。
结论：**9 项全部通过。** 首轮 9 项中 8 项通过，第 4 项「格式非法逐项拒绝」中「长度 >48」子项在页面层不成立（`maxlength=48` 静默截断）；实现者以 PR #308 返修并部署后，复验该子项 7/7 判定全通过，第 4 项整体转为通过。

## 目录

| 路径 | 内容 |
|---|---|
| `metrics/api-results.json` | 接口层 8 项验收结果（A1–A9，含请求/响应原文） |
| `metrics/ui-results.json` | 页面层 7 项验收结果（U1–U7，含 DOM 实测值、请求计数、字段错误文案） |
| `metrics/ui-clicks.json` | 站内真实点击路径 4/4 结果（首页 / 回收站 / 搜索 / 设置，验证新 slug 地址可用） |
| `metrics/ui-links.json` | 新旧 slug 四个 `/s/` 入口逐个打开的页面正文判定 |
| `metrics/baseline-redacted.json` | 验收前生产基线快照（2026-11-26T19:47:49Z）：各表计数、孤儿行、R2 两桶 key 全量 |
| `metrics/verify-final.json` | 清理后终核：逐表计数与基线比对、20 项残留扫描、孤儿复查、双 R2 桶 diff、auth_counters 比对 |
| `metrics/r2-content-cleanup.json` | `ciki-content` 多出对象的归属确认与删除记录（取回→gunzip→逐字比对→sha256 一致→删除） |
| `metrics/final-check.json` | 最后一次复核（auth_counters 167/168、双桶 991/991） |
| `metrics/ui-recheck-results.json` | 返修复验（`v1.0.0-321-2cc27e1`）第 4 项「长度 >48」页面层 7/7 判定结果（R1–R7） |
| `metrics/recheck-verify.json` | 返修复验数据拆除终核：13 项计数与复验前基线全同、残留 11 项全 0、双 R2 桶 diff 为零、auth_counters 168/168、已删账号回访 401 |
| `metrics/baseline-recheck-redacted.json` | 复验前生产基线快照：各表计数、孤儿行、R2 两桶 key 全量、auth_counters 168 行（脱敏后） |
| `counters/gql-returned.json` | Cloudflare GraphQL Analytics 查询日志（分钟级，含 rowsReturned/rowsWritten）——auth_counters 归因主证据 |
| `counters/gql-window.json` | 同上（分钟级采样，含 rowsRead） |
| `counters/gql-hourly.json` | 近 24h `DELETE` / `INSERT…ON CONFLICT` 按小时分布——证明窗口内除清理脚本外无其他 DELETE |
| `counters/gql-auth-counters.json` | 查询日志原始抓取件 |
| `counters/auth-counters-live-redacted.json` | 终态 `auth_counters` 全量 167 行（IP 已掩码；0 行含 18324/18325） |
| `shots/*.png` | 22 张页面截图（首轮 `u1`–`u7` 各验收项、`u2-new-*`/`u2-old-*` 四入口对照、`click-*` 站内真实点击；返修复验 `r4-length-invalid`/`r4-length-save-blocked`/`r4-length-cleared`） |

## 关键数字（自洽链）

- 基线 168 行 → 清理前 170 行（19:59Z 扫描 `rowsRead=340 ÷ 采样倍率 2`）→ 清理删 3 行（20:01Z `rowsWritten=18 ÷ 6`）→ 终态 167 行（20:04Z 起多次 `COUNT(*)` 与全量 dump 复核）。
- 清理删掉的 3 行＝QA265 自身创建的 3 个键：`read_token:18324:`、`write_token:18324:`（`POST /api/me/tokens`，`worker/src/routes/me.ts:527-528`）、`read:18324:`（read 令牌调读接口，`worker/src/middleware/read-token.ts:93-97`）→ **零误删**。
- 基线与终态差 1 行＝本单一次成功的令牌鉴权触发 `resetCounter`（`read-token.ts:91` → `DELETE … WHERE key = ?`）清掉本机出口 IP 的失败计数行，属应用设计内行为（近 24h 同类单键 DELETE 约 1500 次，峰值 06:00Z 460 次）。

## 脱敏说明

- 计数器 dump：IPv4/IPv6 掩码（保留 `action:account:ip` 形态与计数、窗口时间），`public-ip-*` 假名保留原样。
- 基线（首轮与复验）：真实空间名去除，只留 `id`/`slug`。
- 全部工件无会话令牌、无口令、无 Cookie；QA265 铸数脚本与口令文件在测完后已从工作树删除，未入库（返修复验脚本全程在 `/tmp`，未进工作树）。
