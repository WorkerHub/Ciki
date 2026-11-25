# QA 验收报告：主题风格跟账号

- **工单**：todo #194（#191 账号跟主题风格 + #192 设置页改造，GitHub PR #273/#274）
- **被测实现**：main 提交 `855c5f4`（feat: sync style with account）、`e9e92e7`（schema_v13 + themeStyle 端点），及其后两笔纯样式修版 `f12c278`（#270）、`24bc952`（#271）
- **验收执行**：本地栈与生产**同 commit `24bc952` 真跑**（生产 `v1.0.0-288-24bc952`；本地指纹 `v1.0.0-288-24bc952-qa`）。首轮跑在 `f12c278`，生产升级到 288 后重建前端、重启本地栈，**42 项断言全套重跑，两轮结果逐项一致**（缺陷在生产同 commit 上确定性复现）
- **总体结论**：**5 项通过，1 项不通过（项2）**。不通过项为真实缺陷 D1（详见下文），建议修复后单独重验项2；其余各项的通过结论不受 D1 影响
- **证据目录**：本分支 `qa/evidence/theme-account/`（不进 main）

---

## 环境与测法

- 生产注册已关闭（`/api/auth/config` → `registrationEnabled:false`），无法在生产新建账号，故沿用 Jim 真跑惯例（#51 先例）：**本地栈跑与生产完全相同的 commit** 完成六项实测，生产只做只读核对。
- 本地栈：wrangler dev（`127.0.0.1:9464`），D1 本地持久化，schema_v13 迁移真跑通过（账本 v1–v13 全 applied）；首个自注册账号即管理员（免审批），账号 `qa-jim-theme@example.com`（口令存 `/tmp/ciki-qa-jim.pw`，0600，不入档）。
- 真实浏览器实测：Playwright + Chrome for Testing 159（headless），**全部走真实 UI**——填表单登录、点风格单选项、点保存、等成功提示、真实刷新，断言 `data-theme`/`data-mode`/`.dark`/`colorScheme`/meta theme-color/localStorage 镜像/网络请求五类痕迹。
- 生产只读核对：`/api/public` 版本串 `v1.0.0-288-24bc952` 与 main HEAD 一致；`registrationEnabled:false`、`emailConfigured:true`。

---

## 逐项签收

### 项1：账号在浏览器1 设纸面保存 → 刷新仍纸面；浏览器2 登录同账号 → 自动应用纸面 —— **PASS**

- **标准**：保存后服务端与本地均纸面；刷新后保持；浏览器2 只登录、不碰设置页即呈现纸面。
- **测法**：B1 登录（默认 nova）→ 设置页点「纸面」→「保存」→ 等「主题风格已保存。」提示 → 抓 `PUT /api/me/theme` 请求与响应 → 刷新 B1 → B2 全新浏览器登录同一账号。
- **结果**：全部符合。保存 PUT 200 且响应 `themeStyle:"paper"`；B1 刷新后 `data-theme=paper`、镜像 `style:"paper"`；B2 登录后未做任何操作即 `data-theme=paper`（服务端 `paper`）。
- **证据**：`results-full.json` 项1-a~项1-f（6 子项全 PASS）；截图 `20-item1-settings-before.png`、`21-item1-paper-saved.png`、`22-item1-b2-auto-paper.png`。
- **顺带确认**：保存按钮在无变更时禁用（初始 `disabled:true`），有变更才可点——防误存设计生效。

### 项2：浏览器2 改回 Nova 保存 → 浏览器1 刷新后变回 Nova（服务端为准）—— **FAIL（缺陷 D1）**

- **标准**：B2 保存 nova 后，B1（本地镜像仍为 paper）刷新应呈现 nova，服务端保持 nova。
- **测法**：B2 设置页改选 Nova 保存（PUT 200、服务端确认 nova）→ B1 刷新，抓刷新期间全部 `/api/me*` 请求 → 断言 B1 界面与服务端值。
- **结果**：**不符合**。B1 刷新期间前端发出 `PUT /api/me/theme {"themeStyle":"paper"}`（200），服务端被改回 paper；B1 刷新后 `data-theme=paper`，服务端 `paper`。**「服务端为准」被一次性迁移回写破坏**。
- **证据**：`results-full.json` 项2-c `putDuringReload` 字段（完整 PUT 正文与响应体）；截图 `23-item2-b2-nova-saved.png`（B2 已保存 nova）、`24-item2-b1-after-reload.png`（B1 刷新后仍纸面）。
- **根因**：`web/src/stores/theme.ts:78-88`——迁移分支条件 `serverStyle === "nova" && localStyle === "paper"` **没有任何持久化的「已迁移」标记**（`migrating` 只是内存并发防重，刷新即重置），因此每次刷新/登录只要服务端为 nova 且本地镜像为 paper 都会触发回写。与同文件 `:66-67` 的注释「把本地值回写服务端**一次**；此后一律以服务端为准」直接矛盾。
- **影响**：任一浏览器只要本地镜像停在 paper，用户在其他浏览器把账号改回 nova 的操作会被该浏览器下一次刷新**静默覆盖回 paper**，用户意图丢失。首轮（f12c278）与本轮（24bc952）复现结果一致，非偶发。
- **修复方向**（供参考，实现取舍归实现侧）：为「已成功同步过账号」落一个 localStorage 持久化标记（如 `ciki-theme.state` 内 `migratedAt`），标记存在即不再走迁移分支；设置页保存成功与迁移回写成功都应落标记。注意：**没有该标记时，项2 与项4 在客户端视角不可区分**（两者都是「服务端 nova + 本地 paper」），任何不带持久化标记的改法都无法同时满足两条口径。

### 项3：亮暗不跨浏览器同步；设置页无亮暗控件；顶栏循环按钮行为不变 —— **PASS**

- **标准**：B1 切暗后 B2 不受影响（含刷新）；设置页主题卡片内无亮暗控件；顶栏循环按钮在各页可用且循环行为（自动→浅→深→自动）与旧版一致；亮暗切换不写服务端。
- **测法**：B1 顶栏循环按钮连点三轮（auto→light→dark→auto，配合 `emulateMedia` 模拟系统暗/亮验证 auto 跟随）；9 个页面扫描循环按钮存在性与 aria 文案；监听全程 `/api/me/theme` PUT 计数；设置页卡片结构检查。
- **结果**：全部符合。切暗后 B2（含刷新后）保持亮色；亮暗切换全程 **0 次** `PUT /api/me/theme`、服务端值不变；9 页（空间首页/页面视图/设置/个人资料/通知/搜索/回收站/关于/管理）循环按钮全部在位，aria 为「主题：{{label}}，点击切换」；auto 在系统暗时正确变暗、系统亮时正确变亮；设置页卡片内无任何亮暗控件（`hasLightDarkControl:false`）而顶栏按钮正常。
- **证据**：`results-full.json` 项3-a~项3-f；截图 `25-item3-b1-dark.png`（paper 深色）。

### 项4：一次性迁移——服务端值回默认 nova 后，本地 style=paper 的浏览器登录 → 自动回写并应用纸面 —— **PASS**

- **标准**：全新浏览器预置本地镜像 paper（模拟升级前老用户），登录后应自动 PUT paper 并应用，全程无需进设置页。
- **测法**：先将会话复位服务端为 nova（`PUT /api/me/theme {"themeStyle":"nova"}`，模拟「回默认」）→ 全新浏览器 B3 预置 `localStorage.ciki-theme = {state:{theme:"auto",style:"paper"},version:0}` → 刷新确认未登录时镜像已生效（`data-theme=paper`）→ 登录。
- **结果**：符合。登录后捕获 `PUT /api/me/theme {"themeStyle":"paper"}` 200（响应 `themeStyle:"paper"`）、`data-theme=paper`、服务端 `paper`，全程未进设置页。
- **证据**：`results-full.json` 项4-a~项4-c；截图 `26-item4-b3-migrated.png`。
- **备注**：该行为与缺陷 D1 是**同一条代码路径**——迁移本身工作正常，问题只在它被重复触发（见项2）。

### 项5：未登录打开公开页：不报错，风格为本地镜像/默认 —— **PASS**

- **标准**：两个干净度不同的未登录环境（C1 无镜像=默认 nova/浅；C2 预置镜像 paper+深色）遍历 10 个路径（`/login` `/` `/about` `/notifications` `/search` `/trash` `/admin` `/settings` `/s/space-1` `/p/1`）：无 JS 异常、不白屏、风格取本地镜像或默认、私有页重定向登录页。
- **测法**：逐页 `goto` → 检查 `pageerror` 数组、html 属性、最终 URL。
- **结果**：20 项子断言全 PASS。所有页面 0 个 JS 异常（pageerror 全空）；C1 恒为 nova/浅色，C2 恒为 paper/深色（镜像生效且不报错）；登录态路径全部重定向到 `/login`（未泄露内容）。
- **证据**：`results-full.json` 项5 全部条目；截图 `27-item5-c1-about-default.png`、`28-item5-c2-mirror-paper-dark.png`。
- **说明**：未登录打开 `/login` 时控制台出现 1–2 条 `/api/me` 401「Failed to load resource」资源加载提示——这是登录态探活的预期 401，**非 JS 异常、非功能错误**（`pageerror` 恒为 0），按「不报错」口径判定为可接受；如需完全静默可由前端优化（非本单缺陷）。

### 项6：非法 `themeStyle` 保存请求 → 400 `INVALID_THEME_STYLE`，账号值不变 —— **PASS**

- **标准**：各类非法值被 400 `{"error":"themeStyle must be nova or paper","code":"INVALID_THEME_STYLE"}` 拒绝；探测前后账号值不变；别名端点 `/api/me/theme-style` 行为一致。
- **测法**：登录会话内直发 `PUT /api/me/theme` 10 组非法载荷（`dark`/`PAPER`/`Paper`/`"paper "`/`""`/`paperx`/`null`/`123`/`true`/缺字段）+ 别名端点正反向 + 合法兼容键对照；每步后回读 `/api/me`。
- **结果**：符合。10 组非法载荷全部 400 `INVALID_THEME_STYLE`，探测后账号值不变（nova→nova）；别名端点合法值 200 生效、非法值 400；`{style:"dark"}` 400、`{style:"paper"}` 200。
- **证据**：`29-item6-final.json`（终版，14 组探针全量数据）；`results-full.json` 项6-b~项6-d。
- **说明**：首轮脚本把 `{"style":"paper"}` 当「错键名非法用例」预期 400，实际 200——查证 `worker/src/routes/me.ts:256`（注释「入参支持 themeStyle（或兼容 style）」）与 `:268`（`themeStyle ?? style` 回退实现）后确认 **`style` 是端点明确声明的兼容键，属设计行为，非缺陷**；且兼容键取值同样受 nova|paper 白名单约束（`{style:"dark"}` 400）。终版证据已按此口径修正归类。

---

## 附加发现（非阻塞）

| # | 发现 | 定性 |
|---|------|------|
| F1 | `PUT /api/me/theme` 兼容键 `style`（`me.ts:256/268`），与 `themeStyle` 等价、同样过白名单校验 | 设计行为；建议接口文档写明，避免被当成「校验漏洞」误报 |
| F2 | 登录限流 10 次/300 秒（`auth.ts:106-107`，按 IP 计数含成功登录）；本套验收共 11 次登录，需分窗口执行 | 测试执行注意项；生产环境合理防刷 |
| F3 | 未登录 `/login` 页 2 条 `/api/me` 401 资源加载 console 提示 | 预期探活行为，无 JS 异常；可选前端降噪 |

## 覆盖与局限

- 生产环境未做登录态实测（注册关闭、不使用真实用户账号），生产侧仅只读核对版本与配置；登录态行为以同 commit 本地栈为准。
- 项2 在 D1 修复前**无法与项4 同时满足**（客户端视角状态相同、无持久化标记可区分），此为结构性结论，重验时注意修复方案需同时覆盖两条口径。

## 证据文件清单（qa/evidence/theme-account/，共 19 个）

| 文件 | 内容 |
|------|------|
| `results-full.json` | 42 项断言全量结果 + 各浏览器 `/api/me*` 网络日志（含项2-c 的 PUT 回写证据） |
| `29-item6-final.json` | 项6 终版 14 组探针（含 style 兼容键对照与值不变断言） |
| `20`–`26-*.png` | 项1/2/3/4 关键时刻截图（保存前后、双浏览器、B1 刷新后仍纸面、B1 深色、B3 迁移后） |
| `27`/`28-*.png` | 项5 未登录默认/镜像两环境截图 |
| `01`–`04-*.{json,png}` | 首轮（f12c278）过程留档，结论与终轮一致 |
