# QA #182 复验报告 —— 评论框聚焦环左右不截断（#173 返工 57084c3 真跑签收）

**结论：通过。**
返工版（#173 重做，HEAD `57084c3`）把横向裁剪面从页面画布（`[data-page-canvas]` 的 `overflow-x-clip`，罩住评论区）下移到正文内容列（PageView 的 `div.min-w-0.flex-1`，只罩 ReadView）。真浏览器验收：发表/回复/编辑三处 textarea 聚焦环左右在全部 5 组合完整画出（55/55 通过），基线缺陷组全部复现（30/55），裁剪面迁移经 computed style + 包含关系量测实证，横滚阻截、对齐、预览切换、昼夜主题、PageEdit 溢出全部无回归。

- 验收人：QA 复验（#182）
- 日期：2026-11-24
- 判定口径：沿用 #176——双实例同口径真跑 + 像素级条带对比 + 几何量测，非目测。
- 本轮只做验收，未改任何被测代码。

---

## 1. 被测对象与环境

| 项 | 值 |
|---|---|
| 被测修复 | #173 返工（分支 tds/conv-01a20d58-…，HEAD `57084c3`，构建版本 v1.0.0-265-57084c3，4 文件 +54/−7） |
| 对照基线 | main `8db0e96`（构建版本 v1.0.0-262-8db0e96，与 #176 验收同一基线构建） |
| 被测改动 | `overflow-x-clip` 从 `PageCanvas.tsx` 画布移除；`PageView.tsx` 新增 `div.min-w-0.flex-1`（`overflow-x-clip`）只包 ReadView；CommentSection 为其兄弟节点、在裁剪面之外 |
| 实例 | 基线 `:8907` / 返工版 `:8908`（wrangler dev，`--persist-to` 全新 D1/R2 状态；端口避让 #176 会话遗留进程 :8905/:8906，未触碰他人进程） |
| 实例自证 | 基线加载 `assets/index-Sv1yUk3s.js`（内含 v1.0.0-262-8db0e96）；返工版加载 `assets/index-DqmbIZzZ.js`（内含 v1.0.0-265-57084c3）；见 `base/instance-identity.json`、`fix/instance-identity.json` |
| 浏览器 | Playwright 1.65.1 内置 Chromium（QA 真跑口径，qa141/#176 同款） |
| 视口矩阵 | m375=375×812、m390=390×844（均 isMobile+hasTouch）、desk=1440×900 |
| 主题 | localStorage `ciki-theme` 注入 light/dark；矩阵 5 组合：375-light、390-light、390-dark、desk-light、desk-dark（375-dark 按任务口径省略） |
| 账号/数据 | jim@example.com（管理员）；页面 `/p/1`（聚焦环验收页：2 段落 + 长代码行 + 8 列宽表格 5640px）；顶层评论 + 嵌套回复各 1；两实例数据同构、全新状态 |
| 每构建检查数 | 55（11 项 × 5 组合） |
| console | 两版全程 **0 error / 0 pageerror** |

## 2. 验收口径与方法（与 #176 逐字节同脚本）

主验收脚本 `scripts/qa182-acceptance.mjs` 与 #176 的 `qa176-acceptance.mjs` **除证据输出目录外逐字节相同**（diff 验证过）：

1. **环完整性（像素级）**：textarea 左/右外侧 6px×8px 条带，聚焦 vs 未聚焦逐字节比较；不同=环画出，相同=被裁。
2. **确定性自证**：发表框「未聚焦→聚焦→未聚焦」三连拍，首尾全等（全组合 deterministic=true）。
3. **几何量测**：textarea/画布/h1/分割线 rect、overflowClipMargin、boxShadow、bodyBg（主题证据）；对齐容差 0.6px。
4. **横滚阻截**：视口与内滚容器无横滚；`.tableWrapper`/`pre` 各自内部滚动。
5. **预览切换**：composer 容器 rect 不跳动、可复原、无横滚。

### 2.1 本轮新增检查（返工适配）

- **裁剪面审计**（`scripts/qa182-clip-audit.mjs`）：`[data-page-canvas]` 与正文列包装层（`.wiki-content` 最近 `.min-w-0` 祖先）的 computed overflowX + textarea/评论区 section 的全祖先链横向裁剪元素扫描。#176 脚本的 `overflowClipMargin` 读的是画布——返工后画布无 clip，该字段不再是有效判据，故新增本审计。
- **裁剪面机理量测**（`base|fix/wrapper-mechanism.json`）：包装层 rect、`contains(textarea/section)`、环外扩 ±3px 的实际边界。
- **PageEdit spot-check**（`scripts/qa182-pageedit-check.mjs`）：带 5640px 宽表格的页面进编辑器，页面无横向溢出、表格在编辑器 `.tableWrapper` 内横滚（#176 口径中的不回归项）。

### 2.2 造数说明（与 #176 的差异，如实记录）

#176 用**单元格内嵌长代码行**（pre 白空间不可断行）把表格 min-content 撑到 5638px。本轮发现 `/tmp/qa176` 盘上遗留的 `widen-table.mjs`（24 字符表头令牌 + 可断行中文正文行）在当前环境实测表格 min-content ≈ 1131px，桌面端 1132px 容器下**恰好不溢出**，D2 会假阴性——测试数据与其 #176 实跑版本不一致（数据退化，非应用回归）。

本轮改用 `scripts/qa182-widen.mjs`：单元格带 tiptap `colwidth: [705]`（8 列合计 **5640px**）+ 格内 ~116 字符不可断 ASCII 令牌。渲染链路：cell colwidth → 服务端 `<col width=N>` → 读态解析回 colwidth → TableView `<col style="width:Npx">` → 命中 `index.css` 的 `:has(col[style^="width:"])` 豁免 `max-width:100%` → 表格总宽超出正文宽、`.tableWrapper` 内横滚（该路径正是 `index.css` 注释写明的合法通道）。两实例实测 `table 5640/1132`（desk）、`5640/358`（m390），D2 场景与 #176 的 5638/1132 等价成立。

## 3. 逐项签收表

| # | 验收项 | 标准 | 结果（基线 → 返工版） | 证据 |
|---|---|---|---|---|
| ① | 发表框聚焦环左右完整（5 组合） | 聚焦后环在输入框左右外侧均可见 | 基线 **✗ 全组合被裁** → 返工版 **✓ 全组合画出**（leftRingVisible=true、rightRingVisible=true、deterministic=true） | `fix/*-strip-{left,right}-focused.png` vs `*-unfocused.png`；results.json A1/A2/A3 |
| ① | 回复框聚焦环左右完整 | 同上（左缘缩进 ≈17px、右缘贴边） | 基线 左✓右✗（5 组合）→ 返工版 **左右均 ✓**（replyL=true replyR=true；ta.left=33/301.02，ta.right=374/1416 与基线同值） | B1 明细、`fix/*-reply-composer-autofocused.png` |
| ① | 编辑框聚焦环左右完整 | 同上（左缘缩进 ≈44px、右缘贴边） | 基线 左✓右✗（5 组合）→ 返工版 **左右均 ✓**（editL=true editR=true；ta.left=60/328.02） | B2 明细、`fix/*-edit-composer-autofocused.png` |
| ② | 未聚焦态无环 | boxShadow=none 属正常 | **两版全组合 ✓**（`boxShadow=none`；聚焦时 `0 0 0 3px` 环出现，环源即 textarea ring） | A0 明细 |
| ③ | 输入框与正文列对齐 | 左缘=标题/分割线左缘、右缘=分割线右缘（≤0.6px） | **两版一致全 ✓**：m390 `16/374`、desk `284.02/1416`（h1/sep/ta 全等；375-light 同过） | C1 明细、`*-alignment-comments-top.png` |
| ④ | 夜间模式复查 | dark 下重复 ①②③ | 主题生效 **✓**（dark bodyBg=`oklch(0.145 0 0)`、环色 `oklab(0.556 0 0/0.5)` vs light `oklab(0.708 0 0/0.5)`）；环完整性返工版 **✓** | `fix/m390-dark-*`、`fix/desk-dark-*` |
| ⑤ | 预览切换无布局跳动 | composer 左缘/画布宽不变、无横滚、可复原 | **两版一致全 ✓**（m375/390 `16→16`，desk `284.02→284.02`；canvas 宽不变；E2 复原 ✓） | E1/E2 明细、`*-preview-open.png` |
| T1 | 宽表格/代码块横滚阻截保留 | `.tableWrapper`/`pre` 各自容器内滚动，页面不滚 | **两版一致全 ✓**：pre `2288/341~1130`；table 基线 `5640/343~1132`、返工版同值；`overflowX=auto` | D2 明细、`*-viewport-top.png` |
| T2 | 页面无异常横滚 | `docScrollWidth==innerWidth` 且内滚容器无横溢 | **两版一致全 ✓** | D1 明细 |
| N1 | PageEdit 横向溢出 spot-check | 编辑页无页面级横滚；宽表格在编辑器容器内横滚 | **两版一致全 ✓**：m390 `doc=390/390`、desk `1440/1440`；tableWrap `5640/324`（m390）、`5640/1082`（desk），`overflowX=auto`；console 0 错误 | `base|fix/pageedit-check.json`、`pageedit-*.png` |

## 4. 基线对照与缺陷消除

| 检查（× 5 组合） | 基线 8db0e96 | 返工版 57084c3 | 判定 |
|---|---|---|---|
| A1 发表框聚焦左环 | ✗ 被裁（leftRingVisible=false） | ✓ 画出（true） | **已消除** |
| A2 发表框聚焦右环 | ✗ 被裁 | ✓ 画出 | **已消除** |
| A3 聚焦环完整+确定性 | ✗ | ✓（deterministic=true） | **已消除** |
| B1 回复框左右环 | 左✓右✗ | 左✓右✓ | **已消除** |
| B2 编辑框左右环 | 左✓右✗ | 左✓右✓ | **已消除** |

总分：**基线 30/55，返工版 55/55**。基线失败项恰为 25 项缺陷组（A1/A2/A3/B1/B2 × 5 组合），其余 30 项两版全过、明细值一致（对齐/横滚/预览/主题量测逐值相同），无回归。

## 5. 裁剪面迁移实证（本轮核心证据）

`clip-audit.json`（5 组合）+ `wrapper-mechanism.json`（m390/desk）：

| 量测点 | 基线 8db0e96 | 返工版 57084c3 |
|---|---|---|
| `[data-page-canvas]` computed overflowX | **clip**（缺陷裁剪源，罩住评论区） | **visible**（不再裁切） |
| 正文列包装层（`.min-w-0`）computed overflowX | visible | **clip**（裁剪面收窄至正文列） |
| textarea 祖先链上 `overflow-x: clip` 元素 | 有（画布，链首） | **无**（仅剩 overflow-y-auto 滚动容器与 overflow-hidden 壳层，与基线相同、非环截断源） |
| 评论区 section 祖先链上 `overflow-x: clip` 元素 | 有（画布） | **无** |
| 包装层 rect / contains(textarea) / contains(section) | — | m390 `16..374`、desk `284.02..1416`（=正文列）；textarea/section 均不在其内（`contains=false`） |
| 环外扩边界（textarea ±3px） | 13/377（m390）、281.02/1419（desk） | 同值；因发表/回复/编辑三框均在裁剪面之外，环完整画出 |

机理结论：返工版裁剪面=正文内容列；三处输入框与评论区整体位于裁剪面之外，环不再有任何 `overflow-x: clip` 祖先；正文内部的宽表格/代码块仍由 `.tableWrapper`/`pre` 容器滚动阻截（T1 量测不变），永不触及包装层裁剪边界——Tony 边界保持。

## 6. console 记录

两构建 × 5 组合 + PageEdit spot-check 全程 `console.error` 与 `pageerror` 均为 **0**：`base/console.json`、`fix/console.json`、`base|fix/pageedit-check.json`。

## 7. 证据索引

```
qa/qa182-evidence/
├── base/    # 基线：35 件组合截图 + 32 件条带 PNG + results.json（30/55 明细）+ console.json
│            # + clip-audit.json + wrapper-mechanism.json + pageedit-check.json + pageedit-*.png + instance-identity.json
├── fix/     # 返工版：同结构，results.json（55/55 明细）
└── scripts/ # 可复跑：qa182-acceptance.mjs（主验收，与 #176 除输出目录外逐字节同）、qa182-seed.sh、
             # qa182-widen.mjs（colwidth 造数）、qa182-clip-audit.mjs、qa182-table-probe.mjs、qa182-pageedit-check.mjs
```

复跑路径：`bash qa182-seed.sh <port> <base|fix>` 建数 → `node qa182-widen.mjs <port> <tag>` 撑表格 → `node qa182-acceptance.mjs <port> <tag>`；双实例 wrangler dev（`--persist-to` 独立目录）。

## 8. 签名

QA #182 复验——真跑双实例同口径对照（基线缺陷全复现、返工版缺陷全消除、非回归全保持）：**通过，建议签收 #173 返工（57084c3）**。
