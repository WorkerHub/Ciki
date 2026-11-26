## 验收报告（QA 实测，2026-11-27，生产站点）

**最终结论：9 项全部通过，签收通过。**

- 首轮（`v1.0.0-320-bcdac31`）：9 项中 8 项通过，第 4 项「长度 >48」子项在页面层不成立（前端 `maxlength=48` 静默截断）。
- 返修（PR #308 / `2cc27e1`，移除 slug 输入框 `maxLength`）已合入并部署（`v1.0.0-321-2cc27e1`）后，仅重验第 4 项「长度 >48」页面层：7/7 判定全通过（见下文「返修复验」章节）；其余 8 项与第 4 项其余 7 个子项的既有签收结论不变，未重测。

证据件：本分支 `qa/qa265-evidence/`（指标 JSON、计数器脱敏 dump、GraphQL 只读分析日志、22 张页面截图），本报告：`qa/qa265-report.md`。

### 验收环境

- 生产站点 `https://ciki.oneboy.app`；首轮实测版本 `v1.0.0-320-bcdac31`（页面页脚 `Ciki · 1.0.0 · bcdac31+build.320`），返修复验实测版本 `v1.0.0-321-2cc27e1`（`GET /api/public` 自证）。
- 规格里记的 main HEAD `d8322dc` 已被生产上的 `bcdac31` 超越；`bcdac31` 包含 PR #305（服务端 slug 写入）+ #306（前端 slug 编辑），故本次验收对象是**含目标提交的更新部署**，不是 `d8322dc` 本身。
- 测试数据（全部为 QA265 专用，测完已清理）：首轮 — 管理员 `qa265admin`(id 18324)、普通成员 `qa265editor`(id 18325，主测空间内 editor)、主测空间 id 22、冲突对照空间 id 23（slug `qa265-slug-conflict`）、验收页 id 434、read 令牌 id 22（限主测空间）、write 令牌 id 23；返修复验 — 管理员 `qa265radmin`(id 18326)、专用空间 id 24（slug `qa265r-slug-length`）。
- 测法：真实 Chromium（Playwright，登录生产真实页面）+ 真实 HTTP 请求；生产写操作只落在上述 QA265 专用空间/用户，未触碰任何其他真实空间。

### 逐项签收

**1. slug 改成功后立即跳转 `/s/<新 slug>/settings` —— ✅ 通过**

- 标准：保存成功后浏览器地址栏立刻变成 `/s/<新 slug>/settings`。
- 测法：真实 Chromium 登录 → 空间设置页改「空间地址」→ 点「保存」→ 读地址栏、输入框值、接口读回与请求状态。
- 结果：通过。地址栏 `/s/qa265-ui-renamed/settings`（replace 跳转，不新增历史项）；输入框值 `qa265-ui-renamed`；`GET /api/spaces/22` 读回一致；`PUT /api/spaces/22 {"slug":"qa265-slug-renamed"}` → 200 `{"id":22,"slug":"qa265-slug-renamed",...}`。
- 证据：`qa/qa265-evidence/metrics/ui-results.json` → U1；`qa/qa265-evidence/shots/u1-slug-renamed.png`；`metrics/api-results.json` → A1。

**2. 四个 `/s/` 入口用新地址可用、旧地址 404 —— ✅ 通过**

- 标准：空间首页、回收站、空间搜索、空间设置用新 slug 都能打开；旧 slug 地址返回 404。
- 测法：(a) 浏览器依次打开 4 个新地址与 4 个旧地址读页面正文；(b) 站内真实点击：侧栏切换器选空间、账号菜单→回收站、顶栏搜索框回车、切换器→空间设置；(c) `GET /api/spaces` 看空间列表里还有没有旧 slug。
- 结果：通过。新地址 4/4 渲染出对应功能页；站内真实点击 4/4 落到新地址且无 404；旧地址 4/4 显示「页面不存在 / 链接可能已经失效，或者页面被移进了回收站。」；空间列表里已无旧 slug。
- 证据（实测页面正文首屏）：新地址 — 首页 `/s/qa265-ui-renamed`（落到空间首个页面 `/p/434`，正文含「QA265 slug 验收页」）、回收站 `/s/qa265-ui-renamed/trash`（正文含「回收站」）、搜索 `/s/qa265-ui-renamed/search?q=QA265`（正文含「搜索」）、设置 `/s/qa265-ui-renamed/settings`（正文含「空间信息」）；旧地址 `/s/qa265-slug-renamed` 及其 `/trash`、`/search`、`/settings` 正文均含「页面不存在」。
- 口径说明（重要）：`/s/*` 是前端路由，服务器对这些地址一律返回 SPA 外壳 HTTP 200；404 由 `/s/:slug` 网关（`SpaceRoute`）按 slug 在 `GET /api/spaces` 列表里查不到空间时渲染 `NotFound`。「旧地址 404」= 旧地址不再解析到该空间，与站内 404 页语义一致。
- 证据文件：`metrics/ui-results.json` → U2；`metrics/ui-clicks.json`；`shots/u2-new-*.png`、`shots/u2-old-*.png`、`shots/click-*.png`。

**3. 唯一性冲突 → 409、原 slug 不变、UI 字段下提示 —— ✅ 通过**

- 标准：改成另一个已存在空间的 slug → 返回 409、原 slug 不变、UI 在字段下显示冲突错误（zh「这个空间地址已被占用」）。
- 测法：接口层把主测空间 slug 改成对照空间 `qa265-slug-conflict`；页面层在「空间地址」填同值并保存，读字段错误文案、请求状态、接口读回。
- 结果：通过。`PUT /api/spaces/22 {"slug":"qa265-slug-conflict"}` → **409** `{"error":"Space slug is already taken","code":"SPACE_SLUG_TAKEN"}`；改后读回 slug 仍是 `qa265-slug-renamed`；页面层字段下方红字「这个空间地址已被占用」（`aria-invalid=true`，输入框红框），请求状态 409，slug 未变。
- 证据：`metrics/api-results.json` → A3；`metrics/ui-results.json` → U3；`shots/u3-conflict.png`。

**4. 格式非法逐项拒绝（字段级报错并拦保存） —— ✅ 通过（首轮接口层 8/8、页面层 7/8；返修后页面层 8/8）**

- 标准：大写、空格、下划线、首尾连字符、连续连字符、长度 >48、空值 → 字段级报错并拦保存。
- 测法：接口层 8 种各发一次 `PUT` 并逐条读回 slug；页面层 8 种各在输入框输入并点「保存」，读字段错误文案、`aria-invalid`、是否真的发出 `PUT /api/spaces/:id`。
- 结果（接口层 8/8 通过，首轮实测）：每种都 **400** `{"code":"INVALID_SPACE_SLUG","error":"Space slug must be 1-48 characters of lowercase letters, numbers and hyphens"}`，且空间 slug 每次都没变。明细：大写 `QA265-Upper`、空格 `qa265 slug`、下划线 `qa265_slug`、首连字符 `-qa265`、尾连字符 `qa265-`、连续连字符 `qa265--x`、49 位、空串。
- 结果（页面层，首轮 7/8）：大写、空格、下划线、首/尾连字符、连续连字符、空值 → 输入框下方红字「只许 1–48 位小写字母、数字与单连字符，首尾不能为连字符」，`aria-invalid=true`，**一次 PUT 都没发出**（0 请求），空间 slug 未变。
- 首轮唯一不通过子项「长度 >48」：地址输入框带 `maxlength=48`（DOM 实测 `maxlength="48"`），填入 49 位后浏览器按值清洗规则把内容**静默截断成 48 位**（截断后本身合法），于是既没有字段级报错（`aria-invalid=false`、无红字），保存请求也照常发出（PUT=1），空间 slug 被改成截断后的 48 位。
  - 复现路径（首轮）：登录 → 空间设置 → 「空间地址」填 49 个字符 → 点「保存」→ 观察：无报错提示，slug 变成前 48 个字符。
  - 首轮证据：`metrics/ui-results.json` → U4（`maxlengthAttribute: "48"`、`lengthItemNote`、8 条逐项明细）；`shots/u4-invalid.png`。
- **返修后的结论（现行为准）**：实现者以 PR #308（`2cc27e1`）移除 slug 输入框的 `maxLength`，改由既有 `isValidSpaceSlug` 即时校验。生产已部署 `v1.0.0-321-2cc27e1`，复验第 4 项「长度 >48」页面层 **7/7 判定全通过**（逐字键入 49 位不截断、字段级报错、`aria-invalid=true`、保存被拦住不发 PUT、slug 不变、改回合法值错误即时清除、改回后可正常保存 200），详见下文「返修复验」。→ **第 4 项整体通过。**

**5. 相同 slug 提交 → 无操作成功 —— ✅ 通过**

- 标准：不改 slug 直接提交 → 成功、不报错、地址不变。
- 测法：页面层直接点「保存」；接口层 `PUT` 传当前 slug。
- 结果：通过。`PUT /api/spaces/22 {"slug":"qa265-slug-renamed"}` → 200、无错误码、slug 不变；页面层无字段错误、出现绿色状态「已保存，切换器里的名称同步更新。」、地址栏仍 `/s/qa265-slug-renamed/settings`、请求 200。
- 证据：`metrics/api-results.json` → A5；`metrics/ui-results.json` → U5；`shots/u5-same-slug.png`。

**6. 只改名称、不改 slug → slug 保持不变 —— ✅ 通过**

- 测法：页面层只填「名称」并保存；接口层 `PUT` 只带 `{"name":...}`。
- 结果：通过。`PUT /api/spaces/22 {"name":"QA265-Slug-Primary-Renamed"}` → 200，读回 name 已变、slug 仍 `qa265-slug-renamed`；页面层 slug 输入框、地址栏、接口读回三者都未变。
- 证据：`metrics/api-results.json` → A6；`metrics/ui-results.json` → U6；`shots/u6-name-only.png`。

**7. 非管理员改 slug → 拒绝（与改名同门槛） —— ✅ 通过**

- 测法：接口层用 editor 会话分别 `PUT {slug}` 与 `PUT {name}`；页面层用 editor 账号打开空间设置页。
- 结果：通过。接口层改 slug → **403** `{"error":"Forbidden"}`，改 name → **403** `{"error":"Forbidden"}`（与改名同门槛），slug 未变；页面层 editor 打开 `/s/<slug>/settings` 直接是「**仅空间管理员可以打开空间设置**」空状态（说明：你在这个空间是编辑或只读成员；改名称、成员与删除空间需要空间管理员权限），**没有 slug 输入框、0 个表单保存按钮**，根本无法发起修改。
- 证据：`metrics/api-results.json` → A7；`metrics/ui-results.json` → U7；`shots/u7-editor-blocked.png`。

**8. 不受影响：`/p/<id>` 页面链接、成员、令牌 API —— ✅ 通过**

- 测法：`GET /api/pages/434`、`GET /api/spaces/22/members`、`GET /api/me/tokens`；用 read 令牌再调读接口；浏览器打开 `/p/434`。
- 结果：通过。页面 200（标题仍「QA265 slug 验收页」）；成员 200（2 人：qa265admin/admin、qa265editor/editor）；令牌 200（2 枚：QA265 read token、QA265 write token）；read 令牌调读接口 200；浏览器 `/p/434` 正常打开（正文含标题与正文）。
- 证据：`metrics/api-results.json` → A8；`shots/u2-new-空间首页.png`（空间首页即该页）。

**9. `GET /api/read/spaces` 返回新 slug —— ✅ 通过**

- 测法：用限定在主测空间的 read 令牌 `GET /api/read/spaces`。
- 结果：通过。200 → `{"spaces":[{"id":22,"name":"QA265-Slug-Primary-Renamed","slug":"qa265-slug-renamed"}]}` —— 返回的是改名后的 slug。
- 证据：`metrics/api-results.json` → A9。

### 返修复验（PR #308 / `2cc27e1` 已合入并部署，仅重验第 4 项「长度 >48」页面层）

- 背景：首轮第 4 项页面层唯一不通过子项由实现者以 PR #308（`fix(web): remove space slug maxlength and validate length in place`，`2cc27e1`）返修：移除 slug 输入框 `maxLength`，继续用既有 `isValidSpaceSlug` 即时校验与保存前拦截。生产 `GET /api/public` 自证已部署 `v1.0.0-321-2cc27e1`，本节复验以该版本为准。
- 范围与测法：只重验第 4 项「长度 >48」页面层（其余 8 项与第 4 项其余子项的既有签收不变，不重测）。新铸专用数据：管理员 `qa265radmin`(id 18326) + 空间 id 24（slug `qa265r-slug-length`）；真实 Chromium 逐字键入并读 DOM、字段错误、`aria-invalid`、PUT 请求数与接口读回。
- 判定 7/7 全部通过：
  1. slug 输入框已无 `maxlength`（`getAttribute('maxlength')=null`，DOM `maxLength=-1`）；
  2. 逐字键入 49 位合法字符后值仍为 49 位，不被截断；
  3. 字段下方出现红字「只许 1–48 位小写字母、数字与单连字符，首尾不能为连字符」，`aria-invalid=true`；
  4. 点「保存」被拦住：PUT 数=0，接口读回 slug 仍 `qa265r-slug-length`，错误仍在；
  5. 改回合法值后错误即时清除（错误列表空、`aria-invalid=false`）；
  6. 改回合法值后保存正常：PUT 200、绿色状态「已保存，切换器里的名称同步更新。」、slug 不变；
  7. 附加抽检：大写、空值仍字段级报错且不发 PUT（超出本次重验范围，仅确认无回归）。
  - 控制台错误 0。截图：`shots/r4-length-invalid.png`（49 位 + 红字报错）、`shots/r4-length-save-blocked.png`、`shots/r4-length-cleared.png`（恢复合法值）；结果件：`metrics/ui-recheck-results.json`。
- 复验数据拆除与终核（对账基线为复验前另取的 `baseline-recheck.json`）：13 项计数逐表与复验前一致（users 4、sessions 14、spaces 7、space_members 21、pages 380、pages_fts 367、page_revisions 815、comments 5、notifications 0、api_tokens 9、token_space_scopes 0、import_tokens 1、pages_active 380）；残留扫描 11 项全 0；孤儿复查与基线一致（sessions 5、api_tokens 4 为基线既有噪音）；R2 `ciki-assets` 1406/1406、`ciki-content` 991/991，无新增无消失；`auth_counters` 现在 168 行 = 复验前基线 168 行，QA265 相关行 0（本轮无令牌调用，未触发 `resetCounter`，无源移行）；已删账号再访问 `/api/spaces/24` → 401。证据：`metrics/recheck-verify.json`、`metrics/baseline-recheck-redacted.json`。
- 本轮过程脚本全部在 `/tmp/ciki-qa265/`，未进工作树；`state-recheck.json`（含口令）测完已删。

### 生产数据清理与终核（首轮，已完成）

- 删除：`page_revisions(434)`、`pages_fts(434)`、`pages(434)`、`token_space_scopes(22,23)`、`api_tokens(22,23)`、`space_members(22,23)`、`spaces(22,23)`、`sessions(用户 18324/18325)`、`users(18324,18325)`；`auth_counters` 里 key 含 18324/18325 的 **3 行**：`read_token:18324:`（建 read 令牌时写）、`write_token:18324:`（建 write 令牌时写）、`read:18324:`（用 read 令牌调读接口时写）。
- 终核计数与基线（`2026-11-26T19:47:49Z`）逐表一致：users 4、spaces 7、pages 380、pages_fts 367、page_revisions 815、sessions 14、space_members 21、api_tokens 9、token_space_scopes 0、comments 5、notifications 0、import_tokens 1、pages_active 380。
- 残留扫描 20 项全 0（含任何含 `qa265` 的用户名/邮箱/空间名/页面标题/令牌/会话，以及 `auth_counters` 的 qa265 相关行）。
- 孤儿复查与基线一致（sessions 5、api_tokens 4 为基线既有噪音，其余 0）。
- R2 `ciki-assets`：1406 → 1406，无新增、无消失（本次未铸对象）。
- R2 `ciki-content`：991 → 991。终核发现多出 1 个对象 `content/47b536fb…0828`（本次建页产生），已先取回、gunzip 解压后与 QA265 文档正文逐字比对、sha256 与 key 一致，确认归属后再删除（`metrics/r2-content-cleanup.json`），复测 991/991 无差异。
- 已删账号的会话再访问 `/api/spaces/22`、`/api/pages/434` → 401；其他真实空间未被写入或改动。
- 证据：`qa/qa265-evidence/metrics/verify-final.json`（终核全量）、`metrics/r2-content-cleanup.json`、`metrics/baseline-redacted.json`。

### auth_counters 比基线少 1 行：归因（已查清，与先前推测不同）

**结论：清理脚本的宽泛 `DELETE … WHERE key LIKE '%18324%' OR key LIKE '%18325%'` 删掉的 3 行，全部是 QA265 自己创建的计数器行，没有误删任何基线行；基线 168 → 终态 167 的 −1 来自应用自身的 `resetCounter` 行为（本单一次成功的 read-token 调用把本机出口 IP 的失败计数行清掉），属设计内常规漂移。**

证据链（全部来自 Cloudflare GraphQL Analytics 的 D1 查询日志，只读；日志为采样聚合，`rowsRead/rowsReturned/rowsWritten` 均需除以同组 `count`（采样倍率）还原为实际值）：

| 时刻(UTC) | 语句 | 采样还原后 | 含义 |
|---|---|---|---|
| 19:47 | `SELECT key, action, count FROM auth_counters` | 扫描 168 行 | 基线快照（与 `baseline.json` 的 168 一致） |
| 19:45 | `SELECT count, window_start … WHERE key = ?` / `INSERT … ON CONFLICT` / `SELECT count, window_start, locked_until … WHERE key = ?` | 各 1 次：命中 1 行、写 1 行、回读 1 行 | 一次**失败的**令牌鉴权（先拒后验路径）刷新了本机 IP 的失败计数行 |
| 19:48 | `SELECT count, window_start AS windowStart FROM auth_counters WHERE key = ?` | 1 次，命中 1 行 | 本单 A8（`GET /api/read/spaces`，read 令牌）**成功**前的失败额度检查，读到同一行 |
| 19:59 | `SELECT key, action, count … WHERE key LIKE '%qa265%' OR '%18324%' OR '%18325%'` | 扫描 170 行，**命中 3 行** | 清理前全表 170 行，匹配的恰好 3 行 |
| 20:01 | `DELETE FROM auth_counters WHERE key LIKE '%18324%' OR key LIKE '%18325%'` | 扫描 170 行，**写 0 回 / 删 3 行** | 清理脚本执行，删 3 行 → 170 − 3 = 167 |
| 20:01 | `SELECT count(*) n … WHERE key LIKE …` | 扫描 167 行 | 清理后残留扫描（恒返回 1 行，计数值为 0，live dump 复核） |
| 20:04 / 20:06 / 20:07 / 20:13 / 20:30 | `SELECT COUNT(*) …` / 全量 dump | 均 167 行 | 终态 167 行，0 行匹配 QA265 |

- **那 3 行匹配的正是 QA265 自己的 3 个键**（源码+脚本双向确认）：`mint` 用 `POST /api/me/tokens` 建两枚令牌，服务端 `worker/src/routes/me.ts:527-528` 对 read/write 各写一行计数器 → `read_token:18324:`、`write_token:18324:`；A8 调 read 令牌读接口，`worker/src/middleware/read-token.ts:93-97` 写 `read:18324:`。其余所有 QA265 请求都走会话 cookie（`spaces.ts` 路由无任何计数器；`GET /api/me/tokens` 列表处理程序无计数器；页面层用 Playwright 注入会话、无密码登录），不产生计数行。
- **−1 行的来源**：`worker/src/middleware/read-token.ts:91` —— 令牌鉴权**成功后**执行 `resetCounter(failKey)`，即 `DELETE FROM auth_counters WHERE key = ?`（`worker/src/core/counters.ts:116-125`），清掉该 IP 的失败计数行。本单的 A8 成功调用触发了它，而该行正是 19:45Z 那次失败调用（同 IP）刷新过、`updated_at` 落在 19:45Z 的行；这解释了为什么终态 dump 里最大 `updated_at` 仍是 18:28:14Z（19:45Z 那行已被 reset 掉，不留痕）。同类单键 DELETE 在生产是常规量：近 24h 日志里 `DELETE FROM auth_counters WHERE key = ?` 合计约 1500 次（峰值 06:00Z 460 次，02:00Z 286、03:00Z 221、05:00Z 250），窗口所在的小时（19:00Z）除清理脚本外无其他 DELETE（同小时另有 10:00Z 的 `DELETE … WHERE action=? AND account=?` 12 次、12:00Z 前序 QA 清理的 `key IN ('write:18316:','write:18317:')` 2 次）。
- **订正说明**：本报告早前版本曾推断「清理误删了 2 行基线旧行（载体只能是 email 形态）」，该推断**不成立**——因为当时把 QA265 自身创建的 3 个匹配键误当成 1 个（漏了 `POST /api/me/tokens` 写的两行），把清理删的 3 行误算成「1 行自建 + 2 行基线」。按现在的实证：清理删的 3 行＝自建的 3 行，**零误删**；被删的基线行只有 1 行，且是应用按设计在令牌鉴权成功后清掉的本机 IP 失败计数行。
- 影响评估：计数器表里被删的那行是 IP 级失败计数（`read_auth_fail::<ip>`），只影响该 IP 的失败额度计数起点，不涉及任何账号、令牌或业务数据；本单 QA265 产生的 3 行也已全部清除，终态 0 残留。
- 证据：`qa/qa265-evidence/counters/gql-returned.json`（分钟级逐语句含 rowsReturned/rowsWritten）、`counters/gql-hourly.json`（24h DELETE / UPSERT 按小时分布）、`counters/auth-counters-live-redacted.json`（终态 167 行全量 dump，IP 已掩码）、`metrics/final-check.json`（`authCounters: now 167 / base 168`）。

### 交付纪律

- 未改任何业务代码（工作树无源码改动），未合并、未部署、未提交到 main。
- 过程脚本（铸数/接口/页面/清理/调查）测完全部从工作树移除，不入库；含口令与会话令牌的文件（`password.txt`、`state.json`）测完即删。
- 入库证据已脱敏：计数器 dump 的 IP 掩码，基线里的真实空间名去掉（只留 id/slug），结果 JSON 与截图中无会话令牌/口令。
- 页面层控制台错误仅 1 条：`Failed to load resource: the server responded with a status of 409 ()`（第 3 项冲突用例的预期响应），其余无错误。

### 未决事项：已全部关闭

- 第 4 项「长度 >48」：实现者以 PR #308（`2cc27e1`）移除 `maxlength`、改用即时校验拦截，生产已部署 `v1.0.0-321-2cc27e1`；复验 7/7 通过（见上文「返修复验」），第 4 项整体转为通过，**无未决项**。
