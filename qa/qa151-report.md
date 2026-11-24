# QA 验收报告（签收表）：#151 作者主页真跑——A 看 B 权限过滤 + 跳转 + agent 归属人 + 改名后旧链接

- **被测对象**：「作者主页后端」（#148 → PR #237）与「作者主页前端」（#149 → PR #240）合并后的 `main` HEAD `e210ea0`
- **版本自证**：前端构建 `build-info.json` = `v1.0.0-249-e210ea0`（截图页脚 `Ciki · 1.0.0 · e210ea0+build.249`）；`GET /api/public` = `v1.0.0-249-e210ea0`（本地 dev 经 `--var APP_VERSION` 注入同一版本串）
- **验收方式**：真实命令 + Playwright 1.65.1（Chromium headless，1440×900）真跑页面点击，**非代码推断，未改任何被测代码**
- **环境**：本地 `wrangler dev :8896` + 本地 D1/R2（miniflare）；`POST /api/setup` 初始化（ciki_ 前缀，schema v1/v9/v10/v11 applied）
- **原始证据留存**：脚本 `/tmp/qa151/`（`qa151-acceptance.mjs` 主验收、`qa151-en-check.mjs` en 抽查、`seed*.sh` 造数）、API 响应 `/tmp/qa151/api/`、Playwright 截图 `/tmp/qa151/shots/`；随本报告入库的为 `qa/evidence-qa151/`（同一批文件的拷贝）
- **总判定**：**19/19 通过（zh 全场景）+ 3/3（en 词条抽查）+ 8/8（API 层核对与边界）**，建议签收

## 种子数据（全部经真实 API 造数）

| 实体                              | id                                                                   | 说明                                                                                          |
| --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| jim（站点管理员，首个注册用户）   | 1                                                                    | 注册接口自动成为管理员                                                                        |
| alice = **A（查看者）**           | 2                                                                    | admin 建号；「共享空间」editor；**不是**「私密空间B」成员                                     |
| bob = **B（被看者）**             | 3                                                                    | admin 建号；「共享空间」editor；「私密空间B」editor；验收中途改名 `bob-renamed`               |
| bob-bot = **agent（归属人 bob）** | 4                                                                    | `POST /api/me/agents` 建；jim（站点管理员=空间 admin）将其加入共享空间 editor；write 令牌建页 |
| 共享空间 / 私密空间B              | 2 / 3                                                                | jim 建；私密空间仅 bob 是成员                                                                 |
| p1 = 1                            | bob 创建于共享空间，**alice 已编辑**（updatedById=2）且 alice 已评论 |
| p2 = 2                            | bob 创建于**私密空间B**（A 无权）                                    |
| p4 = 3                            | bob 创建于共享空间                                                   |
| p3 = 4                            | agent bob-bot 经 `Authorization: Bearer` 写接口创建于共享空间        |

## 签收表（四项覆盖）

| #   | 验收项                                | 测法                                                                                                                                     | 结果     | 关键证据                                                                                                             |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| ①1  | A 看 B 主页仅见 A 有权空间内的 B 页面 | alice 会话真开 `/users/3`，断言列表 2 条（共享空间 2 篇）、页面全文不含「机密」「私密空间B」                                             | **通过** | `zh/01-user3-as-alice.png`（列表恰 2 条，均带「共享空间」徽章）；DOM 断言 items=2、leak=false                        |
| ①2  | 无权空间零泄露（API 层）              | alice `GET /api/users/3/pages` → `total=2`，ids=[1,3]；`GET /api/pages/2`（私密空间页）→ 404 不泄露存在性；响应体无 p2 的 id/标题/空间名 | **通过** | `api/alice-view-bob-pages.json`；S1.0/S1.2                                                                           |
| ①3  | 对照组：admin 全见、本人全见          | jim（管理员）同接口 `total=3` ids=[1,3,2]；bob 本人 `total=3`                                                                            | **通过** | `api/jim-view-bob-pages.json`、`api/bob-view-self-pages.json`                                                        |
| ②1  | 署名行：创建者+最后编辑者均渲染且可点 | alice 开 `/p/1`：meta 行 =「bob 创建于 … · alice 最后编辑于 …」，创建者/编辑者头像（aria-label）与用户名链接各 2 条                      | **通过** | `zh/02-p1-byline.png`；S2.1（creatorCount=2、editorCount=2）                                                         |
| ②2  | 署名行·创建者点击 → `/users/3`        | 真点用户名链接与头像链接各一次                                                                                                           | **通过** | S2.2/S2.5：落地 URL = `/users/3`，h1=bob（`zh/03-jump-creator-to-user3.png`）                                        |
| ②3  | 署名行·最后编辑者点击 → `/users/2`    | 真点 alice 用户名链接                                                                                                                    | **通过** | S2.3：落地 URL = `/users/2`（`zh/04-jump-editor-to-user2.png`）                                                      |
| ②4  | 评论头像/用户名点击 → `/users/2`      | 评论 `data-comment-id` 内头像 `a[aria-label=alice]`（href=/users/2）真点；用户名链接 href 同指                                           | **通过** | S2.4：落地 URL = `/users/2`（`zh/05-jump-comment-avatar-to-user2.png`）                                              |
| ③1  | agent 主页带归属人显示                | alice 开 `/users/4`：h1 =「**bob-bot（bob 的 Agent）**」（ownerName 非空的归属人显形形态），列表含 agent 页面                            | **通过** | `zh/06-agent-user4-as-alice.png`；S3.1                                                                               |
| ③2  | agent 署名行入口 + 归属人 tooltip     | alice 开 `/p/4`：署名行「bob-bot · Agent · 创建于 …」，头像/用户名可点；hover 头像出 tooltip「bob 的 Agent」                             | **通过** | `zh/07-p3-agent-byline-tooltip.png`（tooltip 可见）；S3.2                                                            |
| ③3  | agent 头像点击 → `/users/4`           | 真点 agent 头像                                                                                                                          | **通过** | S3.3：落地 URL = `/users/4`（`zh/08-jump-agent-avatar-to-user4.png`）                                                |
| ④1  | B 改名后旧链接（按 id）仍可达         | bob `PUT /api/me/profile {"username":"bob-renamed"}` → 200；alice 开旧链接 `/users/3`：显示 bob-renamed、列表仍 2 条                     | **通过** | `zh/09-user3-old-link-after-rename.png`；S4.0/S4.1                                                                   |
| ④2  | 改名后权限过滤依旧                    | 改名后 alice `GET /api/users/3/pages`：`total=2`、无「机密」                                                                             | **通过** | S4.2                                                                                                                 |
| ④3  | 改名后署名行跟随新名、链接仍指 id     | `/p/1` 署名行「bob-renamed 创建于 …」，链接 href=`/users/3`，点击落地正确                                                                | **通过** | `zh/10-p1-byline-after-rename.png`；S4.3                                                                             |
| +   | agent pages 按查看者过滤              | alice 看 agent(4) pages：仅 p3（agent 只在共享空间）                                                                                     | **通过** | `api/alice-view-agent-pages.json`；`api/alice-view-agent-profile.json`（isAgent=true、ownerName=bob、无 email/role） |
| +   | 未登录 / 不存在 / 非法 id             | `GET /api/users/3/profile` 无会话 → **401**；id=999999 → **404**；id=abc → **404**                                                       | **通过** | `api/anon-profile.*`、`api/notfound*`、`api/badid.*`                                                                 |
| +   | 接口无敏感字段                        | 两个 profile 响应体无 email/role/password                                                                                                | **通过** | grep 断言（S1 批次）                                                                                                 |
| +   | 分页与排序                            | `?limit=2&page=2` → total=3、hasMore 正确；默认按 updatedAt 倒序（1→3→2 与库内时间戳一致）                                               | **通过** | S1 批次输出                                                                                                          |
| +   | 「用户不存在」空态 / 本人主页同型     | `/users/999999`、`/users/abc` → 空态文案；alice 开 `/users/2` 走同一主页                                                                 | **通过** | `zh/11-user-not-found.png`、`zh/12-self-user2.png`；S5.1–S5.3                                                        |
| +   | 双语词条（en）                        | alice 切 language=en：`Joined`/`Pages`/`Created`/`Last edited`/`bob-bot (bob-renamed's Agent)` 全部英文形态正确                          | **通过** | `en/20-en-user3.png`、`en/21-en-agent-user4.png`、`en/22-en-p1-byline.png`；E1–E3                                    |

## console 记录

- zh 全场景：2 条 console error，均为「Failed to load resource: 404」——与 S5.1/S5.2 两个「不存在用户」场景一一对应（页面请求 `/api/users/:id/profile` 得 404 后正确渲染空态；浏览器对失败请求的常规记录），**非缺陷**。
- en 抽查：0 条。

## 结论与下一步署名

四项验收覆盖（①权限过滤零泄露 ②署名行/评论头像跳转 ③agent 归属人 ④改名后旧链接）全部通过，且 API 层与浏览器层双口径一致，建议签收。

- Jim 真跑验收（本单 #151）：**通过，建议签收**。
- 对照核 review（#150，Tony）：按其单独立项的口径继续，本报告证据（`qa/evidence-qa151/`）可直接取用。
