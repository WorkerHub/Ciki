# QA 验收报告：自然 / Natural 与墨纸 / E-Ink 主题全矩阵

- 工单：`#253`（ID `XGZN2O3SBAZvAxkYYGSZX`）
- 被测对象：生产环境 `https://ciki.oneboy.app`（D1 `ciki` / 账号 `967399d1b7212c427f5c032b7f7618f2`，R2 桶 `ciki-assets` / `ciki-content`）
- 验收人：QA 测试（独立实测，不改代码）
- 结论：**打回（1 项真实缺陷，12 处表象同源）** — 主体功能通过，natural 浅色 `--muted-foreground` 对比度不达 WCAG AA。

---

## 一、总览

| 项目 | 结果 |
|---|---|
| 主矩阵（4 风格 × 浅/暗 × 12 表面 + 令牌 + 对比度 + 切换 + 持久化 + 重登 + Embed） | **380 项：368 PASS / 12 FAIL** |
| API 契约（`PUT/GET /api/me/theme` + D1 落库 + 非法值拒绝） | **36 项：36 PASS / 0 FAIL** |
| 失败项性质 | 全部为同一处真实缺陷的 12 个表面复现，非 12 个独立问题 |
| 生产测试数据 | 已按 id/key 精确拆除并终态核验，零残留 |
| 遗留数据 | 未触碰（qa234 的用户 id `18306` / 原空间 id `10` 属历史工单，只记录） |

---

## 二、唯一失败项（需上游修复）

**natural / 浅色模式下 `--muted-foreground` 对正文背景的对比度 = 4.46:1，低于验收线 4.5:1。**

| 令牌 | 值 | 背景 | 实测对比度 | 判定 |
|---|---|---|---|---|
| `--primary` | `#5f7050` | `#faf6f1` | **5.36** | PASS |
| `--foreground`（正文） | `#292524` | `#faf6f1` | **14.10** | PASS |
| `--muted-foreground` | `#78716c` | `#faf6f1` | **4.46** | **FAIL** |

- 复现面（12 处，每处独立实测、结果稳定一致）：阅读、编辑、通知、作者页、设置页、管理页 ×6（用户/空间/站点/安全/邮件/其他）、移动端。
- 判定口径：严格 `>= 4.5`，4.46 不四舍五入放行。
- 性质：同一令牌在同一背景上的取值问题，修一处即可同时修复 12 处。
- 归属：主题规格 / `natural` 浅色配色定义（`--muted-foreground: #78716c` 与 `--background: #faf6f1` 的组合）。QA 不代修。
- 建议方向（供实现者判断，QA 不指定实现）：把 natural 浅色的 muted 前景压深到满足 4.5 的档位，或改用更深一档的 neutral 色阶；改后需重跑本单矩阵的 12 处对比度断言。

---

## 三、逐项签收表

### 3.1 令牌一致性（4 组：natural-light / natural-dark / eink-light / eink-dark）

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| `--background / --foreground / --card / --card-foreground / --primary / --primary-foreground / --secondary / --muted / --muted-foreground / --accent / --accent-foreground / --destructive / --border / --input / --ring` 等 17 项与规格文件一致 | 真实页面 `getComputedStyle(document.body)` 读值 → 归一化（hex 展开、数字统一、空白去除、大小写）后与 `evidence/expected-tokens.json` 逐项比对 | **PASS 4/4** | `evidence/matrix-results.json`（4 条「令牌与规格一致」） |

归一化只处理构建序列化差异（百分比 oklch ↔ 0-1 小数、3 位 hex 展开、压缩空格），不做任何数值放宽。

### 3.2 对比度 ≥ 4.5（三组：primary / body / muted）

| 风格 | 模式 | primary | body | muted | 判定 |
|---|---|---|---|---|---|
| nova | light | PASS | PASS | PASS | PASS |
| nova | dark | PASS | PASS | PASS | PASS |
| paper | light | PASS | PASS | PASS | PASS |
| paper | dark | PASS | PASS | PASS | PASS |
| **natural** | **light** | 5.36 | 14.10 | **4.46** | **FAIL** |
| natural | dark | PASS | PASS | PASS | PASS |
| eink | light | PASS | PASS | PASS | PASS |
| eink | dark | PASS | PASS | PASS | PASS |

测量方式：canvas `fillStyle` + `getImageData` 把 oklch 统一量化为 sRGB 8bit 后计算 WCAG 对比度（规避浏览器/库对色函数解析差异），非静态推断。

### 3.3 表面矩阵（12 类表面 × 4 风格 × 2 模式）

| 表面 | 结果 | 说明 |
|---|---|---|
| 阅读页 | PASS（除 natural/light 对比度） | 令牌落地、`data-theme` 正确；页内代码块 / 表格 / 画布预览 / Embed / **评论区** 五类子块各有读数断言，8 组全过 |
| 编辑页 | PASS（同上） | 编辑态 HTML Embed 呈现为卡片 `[data-html-embed-card]`，无 iframe，符合预期 |
| 通知页 | PASS（同上） | 通知项真实渲染（≥2 条） |
| 作者页 | PASS（同上） | — |
| 设置页 | PASS（同上） | 4 张风格卡按钮（Nova/纸面/自然/墨纸）可选 |
| 管理页 ×6 | PASS（同上） | 用户/空间/站点/安全/邮件/其他，量测前等待 `data-theme` 就绪 |
| 移动端 | PASS（同上） | 375 宽视口 |

### 3.4 模式循环与持久化

| 标准 | 测法 | 结果 |
|---|---|---|
| 主题切换按钮循环 auto → light → dark → auto | 真实点击 `button[aria-label^="主题："]`，读取每次切换后的 `data-theme` | **PASS 28/28** |
| 刷新后保持所选模式 | 刷新页面复测 `data-theme` | PASS（含于上项） |
| 设置页保存写入 D1 | 点击保存后查 `users.theme_style` | **PASS 6/6** |
| 重新登录后保留用户主题 | 注入新 session 重新登录，复测 `data-theme` | **PASS 2/2** |

### 3.5 `PUT /api/me/theme` 契约（36 项全过）

| 标准 | 结果 |
|---|---|
| 合法值 `nova / paper / natural / eink` 均返回 200 且回读一致 | PASS |
| 非法值被拒（400 / 不落库） | PASS |
| D1 `users.theme_style` 与返回一致 | PASS |
| `GET /api/me` 回读保持 | PASS |

证据：`evidence/api-theme-tests.json`（36 项全 PASS）。

### 3.6 Embed / agent-guide 真值表（8 组）

| 风格×模式 | iframe src 参数 | 探针主题 | body 底/字色 | chip 底/字色 | 固定高度 | 编辑态 |
|---|---|---|---|---|---|---|
| nova/light | `?mode=light&style=nova` | nova/light | 白 / 近黑 | oklch(0.205 0 0) / oklch(0.985 0 0) | 360（不采纳上报 420） | 卡片无 iframe |
| nova/dark | `?mode=dark&style=nova` | nova/dark | 近黑 / 近白 | 同上 | 360 | 卡片无 iframe |
| paper/light | `?mode=light&style=paper` | paper/light | `rgb(247,244,238)` / `rgb(42,43,47)` | 匹配 | 360 | 卡片无 iframe |
| paper/dark | `?mode=dark&style=paper` | paper/dark | `rgb(11,12,14)` / `rgb(242,240,235)` | 匹配 | 360 | 卡片无 iframe |
| natural/light | `?mode=light&style=natural` | natural/light | `rgb(250,246,241)` / `rgb(41,37,…)` | 匹配 | 360 | 卡片无 iframe |
| natural/dark | `?mode=dark&style=natural` | natural/dark | `rgb(25,22,18)` / `rgb(236,231,221)` | 匹配 | 360 | 卡片无 iframe |
| eink/light | `?mode=light&style=eink` | eink/light | `rgb(245,243,234)` / `rgb(32,33,30)` | 匹配 | 360 | 卡片无 iframe |
| eink/dark | `?mode=dark&style=eink` | eink/dark | `rgb(23,24,20)` / `rgb(236,234,222)` | 匹配 | 360 | 卡片无 iframe |

- 8 组均 PASS；postMessage `ciki-embed-theme` 下发与 `ciki-embed-height` 上报链路验证通过。
- 固定高度 360 在上报 420 后不变 → PASS（8/8）。

### 3.7 Nova / Paper 零漂移（回归）

| 标准 | 测法 | 结果 |
|---|---|---|
| nova/paper 浅暗 4 组的令牌与对比度与改动前一致 | 注入影子 CSS（挂 `document.head`），量测真实页面值与影子基线（`evidence/fa-shadow-baseline.css`）逐项比对 | **PASS 4/4，零漂移** |

证据：`evidence/shadow-tokens.json`、`evidence/fa-shadow-baseline.css`。

### 3.8 控制台无主题相关报错

| 标准 | 结果 |
|---|---|
| 8 组（4 风格 × 浅暗）页面内无主题相关 console error / pageerror | **PASS 8/8** |

**环境噪声说明（判为非应用缺陷）**：sandboxed embed iframe 内出现 `SecurityError: Failed to read the 'localStorage' …`，根因是 Cloudflare 自动注入的 challenge-platform 脚本（`window.__CF$cv$params` + `/cdn-cgi/challenge-platform/scripts/jsd/main.js`，插在 embed 响应 `</body>` 前，带 session cookie 复现）。该错误仅在沙箱 iframe 内抛出，不影响父页面与主题断言，判定为环境噪声，记录不整改。

---

## 四、生产数据拆除与终态核验

拆除顺序（全部按 id / key 精确删除，无批量删除）：

| # | 对象 | 数量 | 结果 |
|---|---|---|---|
| 1 | `sessions`（user 18319/18320） | 8 | changes=8 |
| 2 | `notifications`（id 30,31，recipient 18319） | 2 | changes=2 |
| 3 | `comments`（id 42,43） | 2 | changes=2 |
| 4 | `page_revisions`（page_id 432） | 1 | changes=1 |
| 5 | `pages_fts`（rowid 938, page_id 432） | 1 | 接口报 changes=3，实际行数 368→367（净删 1 行，即目标行） |
| 6 | `pages`（id 432） | 1 | changes=1 |
| 7 | `space_members`（space_id 20） | 2 | changes=2 |
| 8 | `spaces`（id 20） | 1 | changes=1 |
| 9 | `users`（id 18319, 18320） | 2 | changes=2 |

R2 按 key 删除（4 个对象，全部确认 "The specified key does not exist."）：

- `ciki-assets/pages/8fc0ce47-d90d-4e68-af30-9bca4e80c48b.json`
- `ciki-assets/pages/01242c6f-f929-42a6-8541-ec4f3a87284b.png`
- `ciki-assets/embeds/494c21d2-5f9a-4a51-8557-6bc83988c7ec.html`
- `ciki-content/content/c578fb2f05bd7ad674c4a942f75e2696910cb158b164fcb5732317dea9637bd7`（该 content_hash 全库仅本工单 page+revision 引用，删前已核引用计数）

终态核验（按本工单 id / key 精确查）：

| 检查 | 结果 |
|---|---|
| users 18319/18320 | 0 |
| spaces 20 | 0 |
| pages 432 / space_id 20 | 0 |
| comments 42/43、page_id 432 | 0 |
| notifications recipient 18319 | 0 |
| sessions user 18319/18320 | 0 |
| space_members space 20 | 0 |
| page_revisions page 432 | 0 |
| pages_fts page_id 432 / rowid 938 | 0 |
| R2 4 个 key | 全部不存在 |
| 孤儿检查：page_revisions → pages | 0 |
| 孤儿检查：pages_fts → pages | 0（按 `page_id` 口径核对；`pages_fts` 367 行全部对应现存页面，13 条 legacy 页面无 FTS 行为改动前既有） |

全局计数对照（并发期其他任务在改动，仅记录不作为本单失败）：终态 users 4 / spaces 7 / live pages 380 / comments 5 / notifications 0 / sessions 14，与铸数前基线一致。

---

## 五、证据清单（`qa-theme/evidence/`）

| 文件 | 说明 | sha256 前 16 位 |
|---|---|---|
| `matrix-results.json` | 主矩阵 380 项逐条结果（顶层数组） | `3709ab0d9e4a0872` |
| `api-theme-tests.json` | API 契约 36 项结果 | `6996a5ca7deb1587` |
| `expected-tokens.json` | 4 组令牌规格（computed 口径） | `83c103c87ebd0bf7` |
| `shadow-tokens.json` | 影子对比度基线值 | `474c2fb92eff41b6` |
| `fa-shadow-baseline.css` | 影子注入 CSS 基线 | `276ada546c1ed3ff` |
| `baseline-r2.json` | 拆前 R2 桶快照 | `6c12601821512c28` |
| `shots/*.png` | 17 张表面截图（4 风格 × 浅暗 + 通知 + 移动端） | 列表 hash `b09d6c1f0494` |

脱敏检查：全部证据文件不含 session cookie、密码、邮箱明文；`qa-theme/state.json`（含真实 Cookie/密码）仅留本机，未入库。

---

## 六、结论与后续

**验收结论：打回（1 项缺陷）。**

- 主题功能本身实现完整：4 风格 × 浅/暗在 12 类表面全部正确落地，令牌与规格一致，Embed 主题下发与真值表全部通过，切换循环/刷新保持/落库/重登保留全部通过，Nova/Paper 零漂移，API 契约 36/36 通过。
- 唯一阻塞项：natural 浅色 `--muted-foreground: #78716c` 对 `#faf6f1` 的对比度 4.46:1 < 4.5，在 12 个表面稳定复现。请上游修复后重跑本单矩阵的 12 处对比度断言以复验。
- 修复后复验范围：natural/light 在 12 个表面的对比度断言 + 令牌一致性（确认 muted 值改动未破坏 17 项令牌对齐）即可闭环。

**遗留（不属于本单，未处理）**：qa234 的用户 id `18306` / 原空间 id `10` 属历史工单数据，按约定只记录不清理。
