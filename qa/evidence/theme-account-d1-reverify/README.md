# 主题风格·验收补测证据（#211）：D1 修复后重验项2 + 项4

对应工单：todos #211（Ciki 项目）。修复：`876447f`（fix(theme): persist migration marker
to ensure server style precedence, PR #275，Mary #208 实现、Tony 复核通过）。

## 测什么

只重验两项（其余四项已在 #194 签收，不重跑）：

1. **项2 服务端为准**：B2 把账号改回 Nova 保存 → B1（本地镜像 paper）刷新后应变
   Nova，且不得把服务端改回纸面（D1 原回归场景）。
2. **项4 一次性迁移**：服务端值回默认 nova 后，本地 style=paper 的浏览器登录 →
   仍应自动回写并应用纸面（仅一次；之后再刷新不再回写）。

外加修复口径三个核对点：

- `migratedAt` 持久化标记落 localStorage `ciki-theme` 的 `state` 内；设置页保存
  成功（项2-b/项2-d）与迁移回写成功（项4-b）两处都落标。
- 落标后该设备不再走迁移、一律以服务端为准（项2-e/项2-f）。
- 迁移回写失败不落标、保留本地 paper、下次刷新重试成功（口3-f/口3-g）。

## 环境口径（沿用 #194/#51）

- 生产 `https://ciki.oneboy.app` 注册关闭（`registrationEnabled:false`），
  按先例生产**只读核对字节**（见 `prod-byte-check.json`），不写入任何数据。
- 实测在**本地同 commit 栈**：`wrangler dev` @ `127.0.0.1:9465`，
  `/api/public` 指纹 `v1.0.0-289-876447f-qa`；`worker/.dev.vars` 本地生成
  （ENCRYPTION_KEY/SETUP_SECRET 均为一次性随机值，不进仓库、不回显）。
- `POST /api/setup`（X-Setup-Secret）跑迁移：schema v1→v13 全部 applied。
- **测试账号沿用 #194**：`qa-jim-theme@example.com` + 同一口令（`/tmp/ciki-qa-jim.pw`，
  0600；口令绝不进本仓库/工单/日志）。#194 的本地 D1 随其 worktree 栈存在且跑的
  是 pre-fix 构建，无法直接复用其数据库，故在同一 commit 的新栈上用**同一凭据**
  重新自注册（#194 的方法：首个用户=管理员，免审批免验证，默认 themeStyle=nova）。
- Playwright `playwright-core` 1.65.1 + chromium-1255（与 #194 同套），四个独立
  浏览器进程（B1/B2 项2，B3 项4，B4 失败注入），真实 UI 操作（真点设置页 radio
  与保存按钮），`/api` 网络全程捕获，localStorage 逐步断言，逐步截图。

## 方法说明

- 网络捕获只记 `/api` 请求的方法/路径/状态码；请求体仅记 `PUT /api/me/theme`
  （`{"themeStyle":"..."}`，无敏感字段）；登录类请求体一律不落证据。
- localStorage 键为 `ciki-theme`（zustand persist，`{"state":{theme,style,
  migratedAt},"version":0}`）。Spec 写法「ciki-theme.state 内 migratedAt」即此
  键的 `state` 字段，与 `web/src/stores/theme.ts` 的 `partialize` 一致。
- 运行：`node run-reverify.cjs`（需先起本地栈并复位账号 themeStyle=nova）。

## 运行记录（不放水说明）

- 第 1 轮 14/16：两处 FAIL 均为测试装置问题，非产品问题——
  ① 项2-h 断言过严：未登录探活的预期 401 console error 被计入（#194 亦确认
  无害，网络日志证实 401 全部来自登录前的 `POST /api/auth/refresh` 与
  `GET /api/me` 探活）；② 口3-f 失败注入失效：PWA Service Worker
  （`web/public/sw.js`）fetch 直通代发页面请求，`page.route` 拦不到，
  迁移回写实际成功。**此为环境发现**：对这类应用的请求级失败注入需
  `serviceWorkers:'block'` 上下文。
- 第 2 轮 16/17：口3-h 仍 FAIL——b4 多一条 `net::ERR_FAILED` console error，
  正是口3-f 人为 abort 那次 PUT 的浏览器记录（失败注入按设计生效的痕迹），
  应用侧正确接住、无 pageerror。按注入次数精确计入断言。
- 第 3 轮 **17/17 全部通过**（results.json 为最终轮，含全部网络日志）。

## 结果一览（详见 results.json）

| 检查 | 结果 | 关键证据 |
| --- | --- | --- |
| 项2-a B1 登录基线（服务端 nova、无回写） | PASS | putCount=0 |
| 项2-b B1 保存纸面 + migratedAt 落标（设置页保存落标） | PASS | PUT 200、server paper、localStorage style=paper + migratedAt=number |
| 项2-c B2 登录自动应用 paper、不回写 | PASS | data-theme=paper、putCount=0 |
| 项2-d B2 改回 Nova 保存 + 落标 | PASS | PUT 200、server nova |
| 项2-e B1 刷新 → 应用 nova、零回写（D1 不复现） | PASS | putCountBefore==putCountAfter==1 |
| 项2-f B1 二次刷新仍零回写、migratedAt 未动 | PASS | migratedAt 前后同值 |
| 项2-g 服务端仍 nova（独立复核） | PASS | /api/me themeStyle=nova |
| 项2-h 无 pageerror；console error 逐条对应预期 401 | PASS | 计数吻合 |
| 项4-a 种入老用户镜像（paper、未迁移） | PASS | 首屏 data-theme=paper |
| 项4-b 登录迁移：恰好一次 PUT paper 200 + 落标 | PASS | putCount 0→1 |
| 项4-c 迁移后首刷零回写 | PASS | putCount 不变 |
| 项4-d 二次刷新仍零回写 | PASS | putCount 不变 |
| 口3-e B4（SW 屏蔽）登录同步本地 paper、不落标 | PASS | migratedAt=null |
| 口3-e1 服务端复位 nova | PASS | server nova |
| 口3-f 回写失败：不落标 + 保留本地 paper + 服务端未被改 | PASS | aborted=1、migratedAt=null、server nova |
| 口3-g 重试成功：PUT 200 + 落标 + 应用纸面 | PASS | server paper |
| 口3-h B3/B4 无 pageerror | PASS | console error 计数吻合 |

## 生产只读核对（prod-byte-check.json）

- `/api/public` = `v1.0.0-289-876447f`（deploy 注入的 APP_VERSION）。
- 生产入口 chunk 含 `migratedAt`×7、`markMigrated`×2，与本地 876447f 构建计数一致。
- 生产 `build-info` chunk：version/commit/commitCount 与本地完全一致
  （876447f / 289），仅 builtAt（CI UTC）与 timeZone 元数据不同；其余代码 chunk
  去文件名引用归一后逐字节一致。**生产 = 本地 = 同一源码 commit。**

## 证据文件

- `run-reverify.cjs`：真跑脚本（四浏览器、UI 真操作、脱敏网络捕获）。
- `results.json`：17/17 最终轮全量断言明细 + B1–B4 完整 `/api` 网络日志。
- `*.png`：9 张逐步截图（设置页操作前后、B1 刷新后 nova、项4 登录前后镜像/纸面、
  失败保留 paper、重试成功落标）。
- `prod-byte-check.json`：生产字节核对。
