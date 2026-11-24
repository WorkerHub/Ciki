# 第三十三单 · 主题「纸面」验收报告（工单 #186）

> 验收人：QA（独立实测，未改动任何产品代码）
> 被测实现：`main@0e061d3 feat(theme): add paper theme and decoupled appearance style system (#265)`
> （该提交是 PR #265 的**squash 合并**结果：分支 `tds/conv-01a20e10-c906-7eb4-b975-4ece142c7d4e`，分支头 `e4c47d1 fix(theme): refine paper radius, typography, and contrast tokens`，合并后 `0e061d3` 为单父提交 `2ff6d0d`，**分支头的改动内容已全部包含在被测构建内**）
> 生产现状：`v1.0.0-281-c7ddc22`（`0e061d3` 的后继，含纸面主题；`git merge-base --is-ancestor 0e061d3 c7ddc22` 为真）
> 参考站：`https://byte-sized-algorithms.vercel.app/`（标题「大 O 表示法 · Algo Lab」）
> 证据目录：`qa/qa186-evidence/`（截图 + 度量 JSON + 复现脚本）

---

## 0. 结论

**签收通过（PASS）。** 13 项验收点全部实测通过，0 个失败项；另附 5 条不阻断的观察项。

四格（Nova/纸面 × 浅色/暗色）均可达、可持久化、可跟随系统；纸面浅/暗与参考站的背景、前景、代码块底色四项关键色值**逐值相同**；中文回退链有效（未被 Inter 硬套）；纹理为低幅度纸纹，不伤阅读（正文最低对比度 13.06，远高于 WCAG AA 4.5 / AAA 7）；Nova 浅/暗与生产对照**卡片外 0 像素差**、令牌零差异。

---

## 1. 工单关系与本单范围

| 工单 | 角色 | 状态 | 说明 |
|---|---|---|---|
| #184 | 实现单 | 已合入 main | `0e061d3`「feat(theme): add paper theme and decoupled appearance style system (#265)」，纸面主题 + 外观风格解耦（`ThemeStyle=nova\|paper` × `ThemeMode=auto\|light\|dark`）；PR #265 的分支头 `e4c47d1`（圆角/字体/对比度令牌精修）已 squash 进该提交 |
| #185 | 评审单 | 已完成 | 代码层评审；本单只做运行时实测复验，不重复评审意见 |
| #186 | 验收单（本单） | 本报告 | 独立实测 + 签收判定 |

范围说明（重要）：实现单 #184 已先于验收单进入 main 并上线生产，因此本单验收对象是**已上线的事实状态**，而非待发布分支。判定基准为 `main@0e061d3` 与生产 `c7ddc22`；生产比本地多一个头像相关提交（`c7ddc22`），差异归属见 §3.4。

---

## 2. 测法与环境

- **本地新实例**：`http://127.0.0.1:9311`（`/tmp/qa-new`，wrangler dev + 本地 D1，构建自 `0e061d3`）
- **本地旧基线**：`http://127.0.0.1:9312`（`/tmp/qa-old`，构建自相邻旧提交 `2ff6d0d`，用于 Nova 回归对照）
- **生产**：`https://ciki.pama.workers.dev`（外网需经本机代理 `127.0.0.1:7890`）
- **浏览器**：Playwright Chromium（headless），桌面 1440×900、移动 390×844@dsf2（`isMobile`+`hasTouch`），`serviceWorkers: block`，locale `zh-CN`
- **种子数据**（`qa/qa186-evidence/scripts/seed.mjs`）：管理员 + 读者两账号，含中文正文、代码块、表格、画布（Excalidraw 预览 PNG）、HTML Embed 的页面 `/p/1`，以及一条评论 + 一条回复
- **主题注入**：页面加载前写 `localStorage.ciki-theme = {"state":{"theme":"auto|light|dark","style":"nova|paper"},"version":0}`
- **像素对比**：截图 → canvas `getImageData` 逐像素比较（通道差 > 0 计为差异），并做差异簇聚类定位
- **颜色归一**：CSS 计算色（oklch / rgb 混用）统一归一到 sRGB 后算 WCAG 对比度（`contrast.mjs`）

脚本清单见 `qa/qa186-evidence/scripts/`，度量原始数据见 `qa/qa186-evidence/metrics/`。

---

## 3. 逐项验收表

### 3.1 四组合可达

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| Nova/纸面 × 浅/暗四组合均可达 | 设置页「外观」控件点选（实为 `role=radiogroup` + 子项 `role=radio`，判态读 `aria-checked`/`data-state`），逐档点选并读根属性 `data-theme`/`data-mode`/`.dark` | **通过**：4/4 到达。默认 `nova/light`（存储 `null`）→ 点「纸面」→ `paper/light` → 点「深色」→ `paper/dark` | `metrics/interact.json`；`shots/interact/settings-paper-dark.png`、`shots/surfaces/paper-{light,dark}-*.png` |

### 3.2 刷新后保持

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 刷新后主题不丢 | 设定纸面+深色 → `reload()` → 读 `localStorage` 与根属性；再切浅色 reload；顶栏循环按钮切档后再 reload | **通过**：3 组刷新后 `data-theme`/`data-mode` 与存储值全部保持（`{"state":{"theme":"dark","style":"paper"}}` 等） | `metrics/interact.json`（`after-reload`、`paper-light-reload`、`cycle-after-reload`）；`shots/interact/after-reload.png` |

### 3.3 跟随系统

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| auto 模式随系统明暗实时切换 | `page.emulateMedia({colorScheme})` 在 auto 下切 light→dark→light（Nova 与纸面各一轮），读 `data-mode`、`.dark`、`meta[name=theme-color]`、body 背景 | **通过**：切换即时生效（浅 `#ffffff` / 暗 `#0a0a0a`），回到浅色即时还原；纸面 + auto + 系统深色 → `paper/dark` 正确 | `metrics/interact.json`（`auto-system-light`/`auto-system-dark`/`auto-system-light-again`/`paper-auto-system-dark`）；`shots/interact/auto-system-dark.png`、`paper-auto-system-dark.png` |

### 3.4 Nova 浅/暗与当前生产对照无变化

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| Nova 浅/暗不得因纸面主题而改变 | ①**令牌层**：本地新版 vs 生产 `/login` 逐项读 14 个语义令牌 + body 背景/前景/字体 + 登录按钮底色/字色/圆角；②**像素层**：本地新版 vs 生产登录页整页逐像素，并把「登录卡片区域」与「卡片以外区域」分开统计；③**回归层**：本地新版 vs 相邻旧提交 `2ff6d0d` 在 6 个表面 × 明暗逐像素 | **通过**：<br>① 令牌差异 **0**（两种明暗全空），meta 差异 **0**（`data-theme`/`data-mode`/`.dark`/body 背景/字体/按钮一致）；<br>② **卡片以外 0 像素差**（浅/暗均 0，最大通道差 0）；卡片内差异经比对为内容差异——本地显示「站点未配置发信…账号请联系管理员开通」，生产显示「还没有账号？注册」，另有版本串 `v1.0.0-280-0e061d3` vs `v1.0.0-281-c7ddc22`，**非主题差异**；<br>③ 新旧像素：`notifications`/`author`/`admin-users` **0 像素差**；`read` 726 px（浅）/717 px（暗）、`home` 719/712 px、`comments` 726/712 px，差异率均约 0.055%，差异簇定位显示：`read` 的 726 px 全部为页脚版本串（378+341 px，y 877–886，`v1.0.0-280-0e061d3` vs `v1.0.0-279-2ff6d0d` 字形不同）+ 侧栏右缘 7 px 的 ±1 灰阶抗锯齿（242 vs 243）；<br>④ 产物级：生产 `index-DFYPoKDG.css` SHA-256 = `a10612dd5fc125d782159e932e45be1a92fc848c448c2e8fd254ddac2e8f165b`，与本地 `0e061d3` 构建产物**逐字节相同** | `metrics/prod-compare2.json`、`metrics/prod-compare.json`、`metrics/prod-split.json`、`metrics/compare2.json`、`metrics/compare2-clusters.json`、`metrics/compare.json`；`shots/prod/{local,prod}-nova-{light,dark}-login-v2.png`；`shots/diff/prod-vs-local-login-card.png`、`shots/diff/diff-overlay-nova-light.png`、`shots/diff/nova-light-{new,old}.png` |

补充：生产 JS 产物 `index-DjUTElR9.js` 与本地 `index-W8k-DQr3.js` 不同，来源是 `c7ddc22` 的头像提交，与主题无关（CSS 未变）。令牌层唯一差异经追查是 `--font-sans-family` 从旧版「直接定义」改为「拆分定义」，解析值同为 `"Geist Variable", sans-serif`，渲染等价。

### 3.5 纸面中文回退链有效

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 中文不被 Inter 硬套、无豆腐块/变形 | 读正文 `font-family`；用 canvas `measureText` 在「正文栈 / 仅 PingFang SC / 仅 Noto Sans CJK SC / 仅 Inter / 系统 sans-serif」五种栈下测同一中文串的 advance 宽度；截图目视核对字形 | **通过**：纸面正文栈 = `"Inter Variable", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif`；五种栈下中文串宽度**同为 449.796875 px**，证明中文实际落到系统 CJK 字体（macOS PingFang SC）而非被 Inter 覆盖；截图中文为正常黑体字形，无 tofu、无横向拉伸 | `metrics/deep-metrics.json`（`fonts.widths`）；`shots/03-final-read-paper-light.png`、`shots/04-final-read-paper-dark.png` |

### 3.6 代码块配色对齐参考站

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 纸面代码块配色与参考站对齐 | 读 `pre` 计算底色/字色/字体栈并算对比度；与参考站同项实测值逐值比对；读高亮 token 颜色 | **通过**：<br>浅色：纸面 `rgb(45,46,50)` / `rgb(233,230,224)` = 参考站 `rgb(45,46,50)` / `rgb(233,230,224)`（**完全一致**），对比度 10.89；<br>暗色：纸面 `rgb(16,17,20)` / `rgb(233,230,224)` = 参考站 `rgb(16,17,20)` / `rgb(233,230,224)`（**完全一致**），对比度 15.16；<br>字体同为 `"JetBrains Mono Variable"` + 中文回退；关键字 `rgb(240,138,109)`、字符串 `rgb(230,196,119)`（参考站同族暖色） | `metrics/deep-metrics.json`、`metrics/reference-metrics.json`、`metrics/contrast.json`；`shots/blocks/paper-{light,dark}-code.png` |

### 3.7 纹理不伤阅读

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 纸面纹理不得降低正文可读性 | 读 `body::after` 纹理规则（opacity/blend/背景图）；在平坦背景区与正文区取像素，统计亮度标准差、最小对比度、5%–95% 分位对比度 | **通过**：<br>浅色纹理 `opacity .55 / multiply`：平坦区亮度标准差 **0.0084**（≤1/255 灰阶，Nova 浅色为 0.0209，更平），背景呈暖白 `rgb(247,244,238)`；正文区最小对比度 **13.06**、分位对比度 **9.36**（≥ AAA 7）；<br>暗色纹理 `opacity .22 / soft-light`：平坦区均值 `rgb(11,12,14)`、标准差 **0**；正文最小对比度 **17.18**、分位 16.57；<br>四格横向对比：正文对比度 nova 浅 19.80 / 纸面浅 13.06 / nova 暗 18.97 / 纸面暗 17.18，纸面两态仍显著高于 AA | `metrics/pixels.json`；`metrics/deep-metrics.json`（`texture`）；`shots/03-final-read-paper-light.png`、`shots/04-final-read-paper-dark.png` |

### 3.8 纸面与参考站观感对照

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 纸面观感对齐参考站 | 同屏并排图 + 令牌逐项对照表 | **通过**：浅色背景 `rgb(247,244,238)`、前景 `rgb(42,43,47)`、对比度 12.88 **三项完全一致**；暗色背景 `rgb(11,12,14)`、前景 `rgb(242,240,235)`、对比度 17.18 **三项完全一致**；代码块底色/字色两态均一致；字体同源（Inter Variable + 中文回退 / JetBrains Mono Variable）。差异项：纸面多了纸纹理与 14px 卡片圆角体系，参考站无纹理 | `shots/05-side-by-side-paper-light-vs-reference-light.png`、`shots/06-side-by-side-paper-dark-vs-reference-dark.png`；`shots/reference/{light,dark}-viewport.png`；`metrics/reference-metrics.json` |

### 3.9 阅读页四类块

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 代码块/表格/画布/Embed 在四格均正常 | 逐块读计算样式与实际渲染尺寸（画布用 `[data-excalidraw-block]` 的预览图 natural/rendered 尺寸；Embed 读 iframe 边框/圆角并进 iframe 内读文档底色与文字） | **通过**：代码块见 3.6；表格纸面浅 `表头 rgb(233,227,218)/字 rgb(42,43,47)`（对比度 11.09）、暗 `rgb(36,38,43)/rgb(242,240,235)`（13.29）；画布预览 480×240 自然尺寸=渲染尺寸、`complete=true`；Embed iframe 外壳随主题着色（边框/底色随主题变化，圆角 8px，与 Nova 一致），内部为独立文档（`body` 白底 `rgb(255,255,255)`、文字 `rgb(42,43,47)`，四格一致，未被主题污染），内容文字「Embed 块内容 · 中文与 English」正常；纸面代码块圆角 14px（Nova 10px）、带纸面内高光阴影 | `metrics/blocks.json`；`shots/blocks/paper-{light,dark}-{code,table,canvas,embed}.png` |

### 3.10 全表面覆盖（13 表面 × 4 格 = 52 项）

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 阅读页、编辑页、评论区、通知面板、通知页、作者主页、设置页、系统管理 6 页在四格均正常 | 对 `read / edit / comments / notif-panel / notif-page / author / settings / admin-users / admin-spaces / admin-site / admin-security / admin-email / admin-others` 逐页访问，读主题根属性并截图，监听 pageerror/console.error | **通过**：52/52 正常，主题根属性与所选组合一致，无渲染异常 | `metrics/matrix-new.json`；`shots/surfaces/{nova-light,nova-dark,paper-light,paper-dark}-*.png`（52 张） |

### 3.11 移动端壳

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 移动端下四格可用、无页面级横向溢出 | 390×844 @dsf2 + `isMobile`/`hasTouch`，7 表面 × 4 组合 = 28 项，量 `documentElement.scrollWidth` vs `innerWidth`，采集触控目标尺寸 | **通过**：28/28 正常；所有表面 `scrollWidth == 390 == innerWidth`，**无页面级横向溢出**；代码高亮 span 右缘超出（right 417/471）但被代码块自身的横向滚动容器包含，属预期行为 | `metrics/mobile.json`；`shots/mobile/paper-{light,dark}-*.png`、`shots/mobile/nova-light-*.png` |

### 3.12 生产纸面主题生效（部署核对）

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 线上确实跑的是纸面主题 | 生产 `/login` 注入 `ciki-theme` 后读根属性与令牌；抓生产 CSS 核对纸面令牌与纹理规则；比对产物哈希 | **通过**：生产注入后 `data-theme=paper`，浅色 `#f7f4ee`/`#2a2b2f`、暗色 `#0b0c0e`/`#f2f0eb`，卡片 `#f9f7f2`/`#1a1b1f`，主色 `#e2705a`/`#e8694e`，radius 8px，字体栈与本地一致；生产 CSS 含 `html[data-theme=paper] body:after{…mix-blend-mode:var(--grain-blend,multiply);opacity:var(--grain,.55);background-image:url("data:image/svg+xml,…")}` 与 `--grain:.55/.22`（构建压缩为单冒号 `:after`，属正常压缩写法） | `metrics/prod-paper.json`；`shots/prod/prod-paper-{light,dark}-login.png` |

### 3.13 CI 与部署状态（事实记录）

| 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 记录被测提交与生产部署的流水线状态 | 读 GitHub Actions 运行记录 | **通过（记录）**：PR #265 分支 CI（Run `45432124518`，head=`e4c47d1`，分支 `tds/conv-01a20e10-c906-…`）**success**；`CI #753 [push] main@0e061d3` 运行 `45434483362` **success**；`deploy #753 [workflow_run] main@0e061d3` 运行 `45434968013` **success**；后续 `main@c7ddc22` 的 CI 亦 success | Actions 运行链接见 §5 |

---

## 4. 观察项（不阻断签收）

| 编号 | 观察 | 判定依据 | 处置建议 |
|---|---|---|---|
| O1 | 画布（Excalidraw）预览 PNG 自带浅色底，暗色模式下仍显示为浅色图片 | Nova 暗色下同一张 PNG 呈现完全相同（`shots/blocks/nova-dark/canvas.png` 与 `paper-dark/canvas.png` 一致），属素材本身而非主题缺陷 | 若要暗色下反色/暗化预览，需产品决策；不由本单判定 |
| O2 | 参考站字体栈比 Ciki 纸面栈更长（多 `Inter`、`Hiragino Sans GB`、`Microsoft YaHei UI`、`Noto Sans SC`、`ui-sans-serif`/`system-ui` 等） | Ciki 栈为等效精简，macOS 实际命中 `PingFang SC`，中文测宽一致 | 若要求逐项对齐参考站栈，可再补 `Noto Sans SC`/`Hiragino Sans GB` |
| O3 | 生产 JS 产物与本地不同（生产 `index-DjUTElR9.js` vs 本地 `index-W8k-DQr3.js`） | 差异来自 `c7ddc22` 头像提交；CSS 逐字节相同 | 无需处置，属正常版本推进 |
| O4 | 矩阵首轮每组合记录 3 条 `Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.` | 四组合条数完全相同（3/3/3/3）→ 与主题无关；应用内唯一沙箱文档是 HTML Embed 的 iframe（`web/src/editor/htmlEmbed/HtmlEmbedBlockView.tsx:219` `sandbox="allow-scripts"`，worker 侧 CSP `sandbox allow-scripts`），旧基线 `2ff6d0d` 同一属性；复跑 13 个表面 × 2 个构建**均未复现**（`errprobe2.mjs`） | 判为瞬时现象 + 沙箱设计使然，不计入缺陷；若需彻底消除，建议在 embed 注入脚本里避免触碰 localStorage |
| O5 | 纸面阅读栏宽固定为 860px，Nova 为全宽（1132px） | 源码有意为之：`web/src/index.css` 中 `--wiki-read-max-width: 860px`（纸面）vs `none`（Nova），由 `html[data-theme="paper"] [data-readview-container]` 应用 | 设计差异，非缺陷；若产品希望纸面也占满宽屏，需产品确认后调整该令牌 |

---

## 5. 证据清单

全部证据在 `qa/qa186-evidence/`：

| 路径 | 内容 |
|---|---|
| `shots/01..04-final-read-*.png` | 四格阅读页整页（`.wiki-content` 元素截图，1440×1800） |
| `shots/05..06-side-by-side-*.png` | 纸面 vs 参考站并排对照（浅/暗） |
| `shots/surfaces/` | 13 表面 × 4 组合 = 52 张（read / edit / comments / notif-panel / notif-page / author / settings / admin-users / admin-spaces / admin-site / admin-security / admin-email / admin-others） |
| `shots/blocks/` | 代码块/表格/画布/Embed 块级截图（纸面浅、纸面暗、Nova 浅、Nova 暗） |
| `shots/mobile/` | 移动端 390×844@2x 截图（纸面浅/暗 + Nova 浅） |
| `shots/prod/` | 生产站纸面/Nova 浅暗截图与本地对照（登录页） |
| `shots/diff/` | 新旧版差异可视化、页脚版本串/侧栏边缘差异簇、生产 vs 本地登录卡对照 |
| `shots/interact/` | 交互验收截图（刷新后保持、系统深色跟随、顶栏循环、设置页纸面暗色） |
| `shots/reference/` | 参考站浅/暗视口截图 |
| `metrics/` | 全部度量原始 JSON：`matrix-new`（52 表面矩阵）、`interact`（可达/持久化/跟随系统）、`mobile`、`blocks`、`contrast`（统一口径 WCAG 对比度）、`pixels`（纹理/正文像素统计）、`deep-metrics`（字体栈/中文测宽/纹理规则）、`reference-metrics`（参考站实测值）、`compare`/`compare2`/`compare2-clusters`（新旧像素与差异簇）、`prod-compare`/`prod-compare2`/`prod-split`/`prod-paper`（生产对照） |
| `scripts/` | 复现脚本（`matrix`/`interact`/`compare2`/`prod-compare2`/`prod-split`/`contrast`/`pixels`/`deep`/`blocks`/`mobile`/`final`/`reference`/`errprobe2`/`seed` 等），口令经环境变量 `QA_PASSWORD` 注入 |

流水线记录（GitHub Actions）：

- PR #265 分支 CI（head=`e4c47d1`）：<https://github.com/WorkerHub/Ciki/actions/runs/45432124518> — success
- `CI #753`（push `main@0e061d3`）：<https://github.com/WorkerHub/Ciki/actions/runs/45434483362> — success
- `deploy #753`（`main@0e061d3`）：<https://github.com/WorkerHub/Ciki/actions/runs/45434968013> — success

---

## 6. 遗留与范围说明

1. **PR #265 的分支头已在被测内容内。** `e4c47d1 fix(theme): refine paper radius, typography, and contrast tokens` 是 PR #265 的分支头提交（分支 `tds/conv-01a20e10-c906-7eb4-b975-4ece142c7d4e`）。因为是 **squash 合并**，`e4c47d1` 不是 `0e061d3` 的祖先提交（`git merge-base --is-ancestor` 为否），但其改动内容已包含在 `0e061d3` 内（已逐项核对：`THEME_META_COLORS` 单一真源、`window.__THEME_META_COLORS__`、`--r-card/--r-ctl/--r-chip` 圆角令牌、`data-readview-container`、`theme.test.ts` 新用例均在 HEAD 中）。因此本报告的判定已覆盖该精修，无需另行复验。
2. **合并/部署不在本单动作范围内。** 本单只核验既有流水线状态并给出签收结论；是否合并、是否再触发部署，由指挥官汇总后请用户拍板。
3. **本单未改动任何产品代码。** 仓库内新增内容仅为本报告与 `qa/qa186-evidence/` 证据目录，沿用仓库既有惯例（QA 过程产物只留在 QA 分支，不进 main 交付物）。

---

## 7. 签收结论

**通过（PASS）** —— 第 3 节 13 项验收标准全部实测通过，无失败项，无需打回。

签收人：QA　｜　报告：`qa/qa186-report.md`　｜　证据：`qa/qa186-evidence/`
