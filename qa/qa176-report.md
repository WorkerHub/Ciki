# QA #176 验收报告 —— 评论框聚焦环左右不截断（#173 修复真跑验收）

**结论：不通过。**
修复版（2074d91）的修复机制 `overflow-clip-margin: 4px` 在 Chromium 上不参与裁剪边计算，聚焦环仍被画布 `overflow-x: clip` 裁掉；缺陷在修复版与基线完全同征同值，未消除。其余验收项（未聚焦态、对齐、横滚阻截、预览切换、昼夜主题）两版一致且达标，无回归。

- 验收人：Jim（QA 真跑）
- 日期：2026-11-24
- 判定口径：本报告所有"通过/不通过"均基于双实例同口径真跑 + 像素级条带对比 + 几何量测，非目测。

---

## 1. 被测对象与环境

| 项 | 值 |
|---|---|
| 被测修复 | #173（分支 tds/conv-01a20d58-…，HEAD `2074d91`，构建版本 v1.0.0-264-2074d91） |
| 对照基线 | main `8db0e96`（构建版本 v1.0.0-262-8db0e96） |
| 被测改动 | `web/src/components/PageCanvas.tsx:17`：`overflow-x-clip` 之上追加 `[overflow-clip-margin:4px]`（+1 行）与 `PageCanvas.test.tsx`（单测） |
| 实例 | 基线 `:8905` / 修复版 `:8906`（本地 wrangler dev，构建时校验页脚版本号自证） |
| 浏览器 | Playwright 1.65.1 内置 Chromium **159.0.8154.6**（QA 真跑口径，qa141 同款） |
| 视口矩阵 | m375=375×812、m390=390×844（均 isMobile+hasTouch）、desk=1440×900 |
| 主题 | localStorage `ciki-theme` 注入 light/dark；矩阵 5 组合：375-light、390-light、390-dark、desk-light、desk-dark（375-dark 按任务口径省略，夜间在 390+desk 复查） |
| 账号/数据 | jim@example.com（管理员）；页面 `/p/1`（聚焦环验收页：2 段落 + 长代码行 + 8 列宽表格）；顶层评论 + 嵌套回复各 1；两实例数据逐字节同构 |
| 每构建检查数 | 55（11 项 × 5 组合） |
| console | 两版全程 **0 error / 0 pageerror** |

## 2. 验收口径与方法

1. **环完整性（像素级）**：对 textarea 左/右外侧 6px 宽条带（中部 8px 高）分别在"未聚焦/聚焦"两态截图，PNG 逐字节比较——不同=环画出，相同=环被裁。
2. **确定性自证**：发表框加拍"未聚焦→聚焦→未聚焦"三连，首尾两拍必须全等（全组合 deterministic=true，测量可信非抖动）。
3. **几何量测**：textarea/画布/h1/分割线 rect、`overflow-clip-margin` computed 值、boxShadow、body 背景色（主题生效证据）。
4. **对齐**：h1 左缘 = 分割线左缘 = 输入框左缘；分割线右缘 = 输入框右缘（容差 0.6px）。h1 为内容自适应宽度，其右缘不作参照。
5. **横滚阻截**：视口与内滚动容器无横向滚动；宽表格 `.tableWrapper` 与代码块 `pre` 各自内部滚动（`scrollWidth > clientWidth` 且页面不滚）。
6. **预览切换**：composer 容器左缘、画布宽度切换前后一致（容差 0.6px）且无横滚。
7. **焦点方式**：`textarea.focus()`（文本输入元素必匹配 `:focus-visible`，与真实键盘/鼠标聚焦等价）。

造数说明：表格单元格 CSS 为 `white-space: break-spaces; overflow-wrap: break-word`，纯文本/内联代码均可在任意点断行，桌面 1132px 内容宽下撑不破列宽；最终用**单元格内嵌长代码行**（pre 白空间不可断行）把表格 min-content 撑到 5638px，使桌面端表格横滚场景成立（`qa176-widen-table.mjs`）。

## 3. 逐项签收表

| # | 验收项 | 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|---|---|
| ① | 发表框聚焦环左右完整（375/390/桌面 × 昼夜） | 聚焦后环在输入框左右外侧均可见、四角圆弧平滑 | 左右 6px 条带聚焦/未聚焦逐字节对比 | **不通过**（修复版与基线同败：左右环均被裁，5 组合全复现；`overflow-clip-margin` computed=4px 已生效但环未画出） | `fix/fix-*-top-composer-{unfocused,focused}.png`、`results/*-results.json` A1/A2/A3 |
| ① | 回复框聚焦环左右完整 | 同上（回复框左缘缩进 17px、右缘贴边） | 同上 + 缩进量测 | **不通过**（左环可见✓、右环被裁✗——右侧截断特征与基线一致） | `fix/fix-*-reply-composer-autofocused.png`、B1 明细 `ta.left=33/301.02, ta.right=359/1416` |
| ① | 编辑框聚焦环左右完整 | 同上（编辑框左缘缩进 44px、右缘贴边） | 同上 + 缩进量测 | **不通过**（左环可见✓、右环被裁✗） | `fix/fix-*-edit-composer-autofocused.png`、B2 明细 `ta.left=60/328.02` |
| ② | 未聚焦态无环 | 无 box-shadow 属正常 | computed boxShadow | **通过**（两版全组合 `boxShadow=none`；聚焦时出现 `0 0 0 3px` 环，证明环源即 textarea ring） | A0 各明细 |
| ③ | 输入框与正文列对齐 | 左缘=标题/分割线左缘；右缘=分割线右缘（≤0.6px） | rect 四点量测 | **通过**（两版一致：m375 `16/359`、m390 `16/374`、desk `284.02/1416`，h1/sep/ta 全等） | C1 明细、`*-alignment-comments-top.png` |
| ④ | 夜间模式复查 | dark 主题生效下重复 ①②③ | localStorage 注入 + bodyBg 断言 | 主题生效 **通过**（dark `bodyBg=oklch(0.145 0 0)`、环色 `oklab(0.556 0 0/0.5)` vs light `oklab(0.708 0 0/0.5)`）；环完整性 **不通过**（同 ①） | `fix/fix-m390-dark-*.png`、`fix/fix-desk-dark-*.png` |
| ⑤ | 预览切换无布局跳动、无贴边 | composer 左缘/画布宽不变、无横滚、可复原 | 切换前后 rect 量测 | **通过**（两版一致：m375/390 `16→16`，desk `284.02→284.02`；canvas 宽不变；复原 E2 通过） | E1/E2 明细、`*-preview-open.png` |
| T1 | Tony 边界：宽表格/代码块横滚阻截保留 | `.tableWrapper`/`pre` 各自容器内滚动，页面不滚 | scrollWidth/clientWidth + overflowX | **通过**（两版一致：pre `2288/341~1130`、table `5638/343~1132`，`overflowX=auto`，页面不滚） | D1/D2 明细、`*-viewport-top.png` |
| T2 | Tony 边界：页面无异常横滚 | `docScrollWidth==innerWidth` 且内滚动容器无横向溢出 | 双层量测 | **通过**（两版全组合相等） | D1 明细 |
| T3 | Tony 边界：外扩 4px 不挤压视口 | 画布宽两版一致、视口无横滚 | 画布 rect + 视口量测 | **通过但空真**（本 Chromium 中 margin 被忽略故无挤压；Firefox 口径未测——环境无 firefox，见 §5） | A3/E1 明细（canvas 宽两版同值 343/358/1131.98） |

## 4. 基线对照

### 4.1 缺陷复现表（任务口径：基线复现 ✓ / 修复版消失 ✗）

| 检查（× 5 视口×主题组合） | 基线 8db0e96 | 修复版 2074d91 | 判定 |
|---|---|---|---|
| A1 发表框聚焦左环画出 | ✗ 被裁（leftRingVisible=false） | ✗ 被裁（同值） | **未消失** |
| A2 发表框聚焦右环画出 | ✗ 被裁 | ✗ 被裁 | **未消失** |
| A3 聚焦环完整（左右+确定性） | ✗（clipMargin=0px） | ✗（clipMargin=4px 但环未画出） | **未消失** |
| B1 回复框左右环 | 左✓右✗（截断特征） | 左✓右✗（同值） | **未消失** |
| B2 编辑框左右环 | 左✓右✗ | 左✓右✗ | **未消失** |

几何量测两版逐值相同：m375 ta L/R=16/359=canvas L/R；m390 16/374；desk 284.02/1416；回复框 +17px、编辑框 +44px 缩进。环 3px 外扩落在画布 padding box 之外，被 `overflow-x: clip` 裁掉。

### 4.2 非回归表（其余量测两版同值）

D1 页面无横滚、D2 表格/代码块容器内横滚、A0 未聚焦无环、C1 对齐、E1/E2 预览切换——**55 项中 30 项通过，两版通过项与明细值完全一致**；修复版唯一数值差异是 `overflow-clip-margin` computed 值 0px→4px（见 §5，该差异不产生任何像素效果）。

## 5. 根因分析与关键发现

**Chromium 159 中 `overflow-clip-margin` 仅当 overflow 双轴均为 clip 时才参与裁剪边计算。**

修复版写法为 `overflow-x: clip`（`overflow-y` 保持 `visible`），该值进入 computed style（4px）但被绘制层忽略，裁剪边仍为 padding box——环被裁，与无 margin 的基线行为逐像素一致。

### 5.1 最小复现矩阵（Chromium 159.0.8154.6，外层 200px 容器 + 子元素 3px 红色 box-shadow）

| 变体 | computed `overflowClipMargin` | 左缘外条带像素 | 判定 |
|---|---|---|---|
| `overflow-x: clip` + `overflow-clip-margin: 4px`（**修复版写法**） | 4px | 全白（red=0/48） | margin 被忽略 |
| `overflow-x: clip`（无 margin，基线等价） | 0px | 全白（red=0/48） | 与上行逐字节相同 |
| `overflow: clip`（双轴）+ `overflow-clip-margin: 4px` | 4px | **red=24/32** | margin 生效，环画出 |
| `overflow-x: clip` + `overflow-y: hidden` + margin | 4px | 全白 | margin 被忽略 |
| 长属性 `overflow-clip-margin-left/right` | 不存在（computed style 无此属性） | — | 未被解析 |

证据：`probe/chromium-minrepro-log.txt`、`probe/probe5-strip-*.png`、`probe/probe6-B-*.png`，脚本 `scripts/qa176-minrepro-*.mjs`、`qa176-png-redcount.mjs`。

### 5.2 App 级现场实验（不改代码，运行时切换）

在修复页（:8906，390×844）上：现状 `overflow-x: clip` 时发表框聚焦环被裁（聚焦/未聚焦条带相同）；仅用 JS 把画布改为 `overflow: clip`（双轴，margin 4px 保留）后，**环立刻画出**（条带不同）。同时证实缺陷位置与可行修复路径。
证据：`probe/app-experiment-log.txt`、`probe/probe8-before-clipX-left-*.png`、`probe/probe8-after-bothClip-left-*.png`、`scripts/qa176-app-live-experiment.mjs`。

### 5.3 浏览器覆盖面含义

- Chrome/Edge（Chromium 系）：修复无效（本验收环境即 Chromium 159）。
- Safari：`overflow-clip-margin` 整体不支持，等同基线缺陷。
- Firefox：支持 `overflow-clip-margin`（规范语义），预期有效，但本环境无 firefox 未实测，不作签收依据。

## 6. console 记录

两构建 × 5 组合全程 `console.error` 与 `pageerror` 均为 **0**：`results/{base,fix}-console.json`。

## 7. 修复路径建议（供 #173 重做，未改任何被测代码）

1. **双轴 clip**：画布改 `overflow: clip` + `overflow-clip-margin: 4px`（5.2 已现场验证环画出）。需评估 `overflow-y` 由 visible→clip 的副作用（画布内容纵向上本就随内容增高，理论无溢出，但下拉/悬浮类子元素如有越界渲染会被裁）。
2. **环内收**：三处输入框改 `ring-inset`（环画在边框内侧），天然不受任何祖先裁剪影响；视觉口径需设计确认。
3. **裁剪面收窄**：把 `overflow-x-clip` 从画布层下移到不含评论区的内层容器（正文列），评论区不再被裁——需重新评估横滚防护面（Tony 边界 T1/T2 由 `.tableWrapper`/`pre` 容器层保障，理论上不受影响，但防护语义变化须 Tony 认可）。
4. 单测观察（非阻断）：`PageCanvas.test.tsx` 断言 className 字符串，单测通过但绘制层失效——建议修复后补一条真浏览器渲染回归（如本报告条带对比法）。

## 8. 证据索引

```
qa/evidence-qa176/
├── base/  fix/          # 两构建各 75 件：5 组合 ×（视口首屏/发表框未聚焦/聚焦/对齐特写/回复框/编辑框/预览态 截图 + 聚焦环条带 6px×左右×两态）
├── probe/               # 最小复现条带 PNG（probe5/probe6）+ App 现场实验条带（probe8）
├── results/             # base/fix-results.json（55 项明细）、console.json（0 错误）、两份实验日志
└── scripts/             # 可复跑：qa176-acceptance.mjs（主验收）、qa176-seed.sh、qa176-widen-table.mjs、
                         # qa176-minrepro-margin-vs-no.mjs、qa176-minrepro-variants.mjs、qa176-png-redcount.mjs、qa176-app-live-experiment.mjs
```

主验收脚本用法：`node qa176-acceptance.mjs <port> <base|fix>`（前置 `qa176-seed.sh <port> <tag>` 建数；本地依赖 playwright）。

## 9. 签名

Jim（QA）——真跑双实例同口径对照，逐项签收见 §3；验收结论：**不通过，退回 #173**。
