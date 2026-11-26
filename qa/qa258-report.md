# QA258 生产最终验收报告：Ciki 六套主题风格（distill 删除后）

| 项 | 内容 |
| --- | --- |
| 工单 | #258 Ciki 主题全矩阵验收（第二批三套 + distill 删除） |
| 被测对象 | 生产环境 `https://ciki.oneboy.app` |
| 生产版本 | `v1.0.0-320-bcdac31`（main `bcdac31`，含 PR #303 / #304 / #307） |
| 验收风格 | nova / paper / natural / eink / notion / sketch（共 6 套）× 明暗 2 模式 = 12 组 |
| 验收时间 | 2026-11-26 ~ 2026-11-27 |
| **结论** | **6 项验收标准全部通过 → 签收**；另有 1 项跨单观察（#259）需产品侧跟进，不影响本单签收 |

> 口径说明：本单只验收、不改代码。所有结论均来自生产真实页面 / 真实接口 / 真实 computed style；生产测试数据已按序拆除并与验收前基线逐项对账（见第 6 节）。

---

## 1. 逐项签收表

| # | 验收标准 | 测法（生产实测） | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 设置页恰 6 套风格、无 distill；六套浅/暗切换正常、刷新保持、账号存储往返正常 | 真实 Chromium 登录生产账号 → 设置页读风格 radiogroup 项数 → 逐风格走「选择 → 保存 → 读回账号 → 刷新页面」全流程；模式读 `localStorage["ciki-theme"].state.mode`（设置值，非解析值） | **PASS 11/11** | `qa/qa258-evidence/metrics/settings-result.json`、`shots/prod-settings-*.png` |
| 2 | 预置 `theme_style='distill'` 账号：读取回落 nova、无报错、可切换并保存其他风格；`PUT /api/me/theme` 传 `distill` 返回 400 | D1 预置 distill 账号 → 打开阅读页读 `data-theme` → 设置页选「手绘」并保存 → 读回账号与刷新后 `data-theme`；另对 8 个非法值调 `PUT /api/me/theme` 与别名端点 `/api/me/theme-style` | **PASS** | `metrics/settings-result.json`（A1–A4、C1–C4） |
| 3 | 阅读页 ≥1280px 时目录轨回到内容区右边缘；正文列宽不限宽 | 12 组（6×2）在 1440px 实测目录轨右缘与内容区右缘之差、阅读容器与正文 `max-width`；另加 1100/1279/1280/1440/1920 五档断点实测 | **PASS**：12/12 差值 = 0px；容器与正文 `max-width` 均为 `none`；正文列宽随视口变化（851→1000→876→1270px） | `metrics/prod-6x2.json`（`read.toc` / `read.wiki`）、`metrics/toc-breakpoint.json` |
| 4 | Embed 消息 `style` 不再出现 distill；旧 Embed `style=distill` 按未知值回落且不崩 | 生产页 6×2 实测 iframe 首帧 URL 的 `mode/style` 与 `ciki-embed-theme` 消息体；旧 Embed 直开 `style=distill` / 未知值 / 空值 | **PASS 8/8** | `metrics/embed-result.json` |
| 5 | `agent-guide` 真值表与生产实测一致（6 风格 × 2 模式） | 下载生产 `/api/public/agent-guide` 真值表（13 列），与生产实测 24 个语义色彩令牌 × 12 组合逐格比色（sRGB 归一化、容差 ±1） | **PASS 288/288**（不一致 0、跳过 0） | `metrics/truthtable-result.json`、`metrics/prod-agent-guide.md` |
| 6 | 除 distill 外，6 套风格与删除前生产零漂移 | 删除前 main `3718ce9` 的本地等价实例（与删除前 tree 逐字相同，7 风格候选）用**同一 harness、同一探针落点**采集，与生产 `v1.0.0-320-bcdac31` 逐字段对比 | **PASS**：12 组 × 19380 字段，差异 463 条**全部归因**（设计内 288 / 数据 130 / 取样假象 45），未归类 0，对比度类字段 0 差异 | `metrics/drift-report-final.json`、`metrics/pre-6x2.json`、`metrics/prod-6x2.json`、`shots/pre-read-*.png` |

---

## 2. 六风格 × 明暗 实测色值与对比度

数据取自生产阅读页 computed style（正文背景 / 正文前景 / 次要文字 / 主要按钮文字对比度）。对比度列与删除前对照实例**完全一致**（零差异），说明下表不是本次删除引入的变化。

| 风格 | 模式 | 正文背景 | 正文前景 | 次要文字 | 主要按钮文字对比度 | 文字/背景对比度 | 次要文字对比度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nova | 浅 | `#ffffff` | `oklch(14.5% 0 0)` | `oklch(55.6% 0 0)` | 17.18 | 19.80 | 4.74 |
| nova | 暗 | `#0a0a0a` | `oklch(98.5% 0 0)` | `oklch(70.8% 0 0)` | 14.23 | 18.97 | 7.66 |
| paper | 浅 | `#f7f4ee` | `rgb(42,43,47)` | `rgb(119,116,111)` | 3.13 | 12.88 | 4.24 |
| paper | 暗 | `#0b0c0e` | `rgb(242,240,235)` | `rgb(144,141,135)` | 3.20 | 17.18 | 5.91 |
| natural | 浅 | `#faf6f1` | `rgb(41,37,36)` | `rgb(120,113,108)` | 5.36 | 14.10 | 4.46 |
| natural | 暗 | `#191612` | `rgb(236,231,221)` | `rgb(163,158,147)` | 7.08 | 14.63 | 6.76 |
| eink | 浅 | `#f5f3ea` | `rgb(32,33,30)` | `rgb(85,87,80)` | 14.56 | 14.56 | 6.59 |
| eink | 暗 | `#171814` | `rgb(236,234,222)` | `rgb(169,168,157)` | 14.77 | 14.77 | 7.45 |
| notion | 浅 | `#ffffff` | `rgb(55,53,47)` | `rgb(110,109,104)` | 4.65 | 12.26 | 5.18 |
| notion | 暗 | `#191919` | `rgb(232,232,230)` | `rgb(155,155,151)` | 6.29 | 14.33 | 6.30 |
| sketch | 浅 | `#f5f0e8` | `rgb(44,44,44)` | `rgb(107,107,107)` | 12.31 | 12.31 | 4.70 |
| sketch | 暗 | `#262420` | `rgb(236,229,216)` | `rgb(168,159,141)` | 12.37 | 12.37 | 5.91 |

既有观察（非本次引入，与删除前一致，仅记录）：paper 浅色主要按钮文字对比度 3.13、natural 浅色次要文字对比度 4.46，均低于 4.5:1；#253 报告已记录 natural 浅色 4.46:1。

---

## 3. 零漂移对比（标准 6）的 463 条差异归因

同一 harness、同一探针落点采集删除前本地实例与生产，逐字段比对 12 组 × 19380 个字段，差异 463 条，全部可归因，**未归类 0、未发现 6 套风格的真实漂移**。

| 类别 | 条数 | 内容 |
| --- | --- | --- |
| 设计内差异 | 288 | ① `--wiki-max-width` 令牌定义整体删除（distill 的 42rem 列宽机制随之移除）：`vars.--wiki-max-width` 84 条 + users/spaces/site/security/email/others 各 12 条 = 156 条；② 设置页风格项 7 → 6 引起的索引位移：`area.styleItems[*].text / .state / .checked` 各 36 条 = 108 条；③ 设置页风格组计数 9 → 8：`counts.toggleItems` 12 + `area.styleItemCount` 12 = 24 条。合计 288 条，均属删除单 #260/#261 的设计意图（阅读容器与正文的 `max-width` 在删除前后本就为 `none`，故无差异条目）。 |
| 数据差异 | 130 | ① 评论归属导致的按钮数与顺序（本地多一条自己评论，多「编辑」按钮）；② 通知文案内容；③ 空间/管理页数据量（本地 1 个空间 vs 生产 8 个）；④ 邮件徽章 variant（本地「邮件未配置」outline vs 生产「邮件已配置」secondary）；⑤ Embed 对象 key 不同。与风格无关。 |
| 取样假象 | 45 | 移动端评论输入框、表格单元格在矩阵取样瞬间尚未渲染（null/undefined）。加长等待复测两侧一致：均为 1 个 TEXTAREA、1 表 2 单元格，逐值样式相同。 |
| 真实缺陷 | **0** | — |

对比度类字段（`fgOnBg` / `mutedFgOnBg` / `primaryFgOnPrimary` 等）**0 差异**。

---

## 4. Embed 验收明细（标准 4）

| 编号 | 检查 | 结果 |
| --- | --- | --- |
| E1 | 12 格 iframe 首帧 URL 的 `mode/style` 与当前风格+明暗一一对应，无 distill | PASS |
| E2 | 12 格 `ciki-embed-theme` 消息的 `style` 均为 6 合法值之一、`mode` 与明暗一致，全程无 distill | PASS |
| E3 | 消息与 URL 中均未出现 distill | PASS |
| E4 | 旧 Embed 直开 `style=distill` / 未知值 / 空值：均不套用未知值（`known=0`），页面照常渲染不崩 | PASS |
| E5 | 服务端注入脚本：dark 类对全部风格正常下发；未知值 distill 不被套用且不崩 | PASS |
| E6 | 【观察项 #259】注入脚本仅对 nova/paper 设置 `data-theme`；natural/eink/notion/sketch/distill 由注入脚本时不设 `data-theme` | PASS（观察项） |
| E7 | 存量 distill 账号在页面里回落 nova：iframe src 与消息 style 均为 nova | PASS |
| E8 | Embed 全部用例无前端报错（过滤 CF 注入 / 沙箱 localStorage 噪声后 0 条） | PASS |

### 观察项 #259（跨单，需产品侧跟进）

服务端上传注入脚本（`worker/src/lib/upload.ts` 的 `applyTheme`）目前只对 `style === "nova" || style === "paper"` 设置 `data-theme`；`natural / eink / notion / sketch` 以及旧的 `distill` 由注入脚本时不设置 `data-theme`。

- 对本单 1–6 的影响：无。注入脚本只影响「作者直接把 Embed 对象当独立页面打开」这一路径的初始主题；阅读页内 Embed 的主题由父页通过 `ciki-embed-theme` 消息下发（E1/E2 已验证 6×2 全部正确），父页本身也正常应用风格。
- 建议：由 #259 单补齐注册表到 6 个合法风格，并决定未知值（如旧 distill）的回落策略（建议回落 nova 而非不设）。

---

## 5. 覆盖面与实测方法

| 覆盖区域 | 实测内容 |
| --- | --- |
| 阅读页 | 12 组（6 风格 × 明暗）：背景/前景/次要文字/按钮/输入框/表格/徽章/正文排版/目录轨/Embed iframe/对比度 |
| 编辑页 | 12 组：编辑壳与工具栏取色、按钮计数 |
| 评论区 | 12 组：评论输入框、评论卡片、按钮集 |
| 通知面板 / 通知页 | 12 组：Radix 面板（真实指针点击打开，非合成 click）、未读标记、通知页文案 |
| 作者页 | 12 组：作者资料卡、按钮集 |
| 六个管理页 | 12 组：用户/空间/站点/安全/邮件/其它，表容器与单元格取色 |
| 设置页 | 12 组 + 专项 11 项：风格 radiogroup、模式循环、保存按钮往返 |
| 移动端壳 | 12 组：390×844 视口，sheet 触发器、输入框、表格单元格 |

方法要点：

1. 风格真源是服务端 `themeStyle`（`GET /api/me`），localStorage 只控 mode；矩阵统一用 `PUT /api/me/theme` 下发风格。
2. 设置页风格控件是受控组件，必须「选择 → 等待 React 重渲染 → 点保存」，不能点完直接读账号（首轮两处 FAIL 均为脚本时序问题，修正后 11/11）。
3. 模式读 `state.mode`（用户设置值）；`data-mode` 是系统偏好解析后的实际模式。headless Chromium 系统偏好为 light，故 `auto` 解析为 light——设置值本身已单独验证可写入并刷新保持。
4. 页面渲染完成信号用「出现按钮 + 页面专有选择器 + 400ms settle」，不使用 `networkidle`（冷启动会出现 0 样本伪影）。
5. Embed 双探针隔离：`probe-6style.html` 测消息/URL 契约并对 6 个合法值自行设 `data-theme`；`probe-bare.html` 不自行设主题，只记录服务端注入脚本结果，避免探针掩盖产品行为。
6. 删除前对照锚点：本地候选 tree 与删除前 main `3718ce9` 逐字相同（`git diff --stat` 为空），故同 harness 采集结果可代表删除前生产表现。
7. 环境噪声剔除：Cloudflare zone 向所有 `text/html` 注入 challenge 脚本；HTML Embed 沙箱内抛 `localStorage` SecurityError。两者均判为环境噪声，未计入前端报错（E8 / C4 过滤后 0 条）。

---

## 6. 生产测试数据拆除与基线对账

拆除顺序：通知 → 评论 → 页面修订 → FTS 行（按 `page_id` 列删，不能按 `rowid`）→ 页面 → 空间成员 → 空间 → 会话 → API 令牌 → 导入令牌 → 用户；随后按 key 精确删除 R2 对象。

本单铸造时的数据量 → 拆除后（以铸数后快照与基线之差为准）：用户 7→4、空间 8→7、成员 24→21、页面 381→380（活页 381→380）、评论 7→5、通知 2→0、会话 17→14、页面修订 816→815、FTS 行 368→367；R2 `ciki-assets` 1410→1406、`ciki-content` 992→991。`metrics/cleanup-result.json` 记录的是**幂等复验**一轮（各步已为 0→0、R2 删除幂等返回 200），首次拆除的净差由上表与基线快照共同佐证。

| 表 / 桶 | 验收前基线 | 拆除后 | 结论 |
| --- | --- | --- | --- |
| users | 4 | 4 | ✅ 一致 |
| spaces | 7 | 7 | ✅ |
| space_members | 21 | 21 | ✅ |
| pages / 活页 | 380 / 380 | 380 / 380 | ✅ |
| comments | 5 | 5 | ✅ |
| notifications | 0 | 0 | ✅ |
| sessions | 14 | 14 | ✅ |
| api_tokens | 9 | 9 | ✅ |
| page_revisions | 815 | 815 | ✅ |
| import_tokens | 1 | 1 | ✅ |
| R2 `ciki-assets` | 1406 对象 | 1406 | ✅ 差集为空 |
| R2 `ciki-content` | 991 对象 | 991 | ✅ 差集为空 |

残留检查（全部为 0 或空）：QA 用户 / 空间 / 页面 / 评论 / 通知 / 会话 / 成员 / 修订 / FTS 行均无残留；孤儿 FTS 0、孤儿修订 0、孤儿成员 0、孤儿评论 0、孤儿通知 0；R2 逐 key 复查 5 个 QA 对象均 HTTP 404（不存在）；已删账号重新登录返回 401 `Invalid credentials`；`auth_counters` 无 `write:<QA uid>` 行，拆前拆后行数一致（168 → 168，含本轮登录尝试产生的新行，属正常基线噪音）。

基线快照未记录 `pages_fts` 总数（QA FTS 行删除后为 367，与铸数前一致）。另发现 5 条**先于本轮存在**的孤儿会话（属已删除的 user 18305，创建于 2026-11-25T13:30Z，早于本轮铸数 2026-11-26T16:10Z），与本单无关，未做处理。

---

## 7. 证据索引

全部证据在本工单分支的 `qa/qa258-evidence/` 下（未进 main）：

```
qa/qa258-evidence/
├── metrics/
│   ├── prod-6x2.json          生产 6×2 全量矩阵（12 组 × 9 个页面区块的 computed style 与计数）
│   ├── pre-6x2.json           删除前对照实例同 harness 采集（零漂移比对基线）
│   ├── drift-report-final.json 463 条差异逐条归因（设计内/数据/取样假象，未归类 0）
│   ├── diff-pre-vs-prod.json 逐字段原始差异
│   ├── settings-result.json  标准 1/2 专项 11 项（PASS 11/11）
│   ├── embed-result.json     标准 4 专项 8 项 + 12 格 Embed 单元格（PASS 8/8）
│   ├── truthtable-result.json 标准 5 真值表 288 格逐格比对（288 pass / 0 fail / 0 skipped）
│   ├── toc-breakpoint.json   标准 3 五档视口断点实测
│   ├── cleanup-result.json   拆除步骤与基线对账结果
│   ├── baseline.json         验收前生产只读基线快照（D1 计数 + R2 key 全量）
│   ├── snap-now.json         拆除前状态快照
│   ├── prod-agent-guide.md   生产真值表原文
│   └── email-pre.json / email-prod.json / explain-pre.json / explain-prod.json  差异归因辅助证据
├── shots/
│   ├── prod-read-<风格>-<模式>.png     生产阅读页 12 张
│   ├── prod-settings-<风格>-<模式>.png 生产设置页 12 张（可见 6 个风格项、无 distill）
│   ├── prod-edit/comments/notif/mobile-*.png  编辑/评论/通知/移动端代表性截图
│   └── pre-read-<风格>-<模式>.png      删除前对照阅读页 12 张（零漂移视觉对照）
└── scripts/                  本轮使用的采集与比对脚本（口令/令牌只走环境变量，不含明文）
```

---

## 8. 遗留与建议（非本单范围）

1. **#259**：服务端注入脚本 `data-theme` 补齐到 6 个合法风格，并明确未知值回落策略 —— 建议回落 nova。影响「独立打开 Embed 对象」的初始主题，不影响阅读页内 Embed。
2. 既有对比度观察：paper 浅色主要按钮文字 3.13:1、natural 浅色次要文字 4.46:1（低于 4.5:1），与删除前一致，建议后续单独评估。
3. 生产 `auth_counters` 中存在 5 条他人遗留孤儿会话（user 18305），建议由该单所属验收清理。
4. 未覆盖：真实 iOS / Android 设备与真实系统深色偏好（headless Chromium 系统偏好恒为 light）；真值表只比对 `agent-guide` 提供的 24 个语义色彩令牌，非令牌未逐一比对。
