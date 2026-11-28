# QA 复验报告：#281「移动对话框长标题穿模残留修复」独立验收（Todo #283，Jim）

- **被测对象**：Ciki `main` HEAD `867906191d1cdbac39475c3d98349d40b4c87ea7`（`8679061`，commitCount 336）。#281 经 PR #323 于 2026-11-28T08:56:48Z 合入 main；本地工作区 `git status` 干净、HEAD = `8679061`；`git diff` 核对 #281 squash 内容与 main 一致（dialog.tsx / alert-dialog.tsx 头部与标题类名、7 处动态标题入口、Description 相关改动已按 Tony 意见回退 f5cc1d7）。
- **构建自证**：worker `GET /api/public` → `{"name":"Ciki","version":"v1.0.0-336-8679061-qa281"}`（`--var APP_VERSION` 注入，`-qa281` 后缀证明本地实例）；web 侧 build-info 由 `scripts/build-info.mjs` 在本工作区生成 `v1.0.0-336-8679061`，与被测 HEAD 同源。
- **CI 自证**：Validate run `46128151072` = success（headSha `8679061`，含 lint/typecheck/test/build 全步骤）；pages deploy run `46128318236` = success（同 headSha）。PR #323 状态 MERGED。
- **验证方式**：真页面 + 无头浏览器（Playwright 1.65.1 + 本机 Chrome 158，headless，deviceScaleFactor=2），本地栈 `wrangler dev :8787`（本地 D1/R2，`--persist-to` 隔离 state）+ `vite dev :5173`（/api 代理到 8787）。逐组合 `getBoundingClientRect()` / `getComputedStyle()` / `scrollWidth` 量测 + 截图留证；**非代码推断、非仅单测**。全量本地测试 `pnpm test` 已跑（见第 5 项）。
- **视口**：桌面 `1280×800`、窄屏 `500×800`（<640px 口径，500 同时覆盖 sm 断点以下的双列按钮堆叠态）。
- **断言**：10 组合 × 3 场景共 **28 项量测记录，最终失败 0 条**（过程中 3 次断言口径修正，均为测试脚本侧、非产品缺陷，见「测试方法记录项」）。
- **结论**：**验收口径四项全部通过，#280 打回的两处残留（标题自身溢出 + 同族删除对话框）在 `8679061` 上确认闭合，建议签收。**

> 证据目录：`qa/qa281-reverify-evidence/`（36 张截图 + `results.json` + `fails.json` + 量测脚本 `verify281.mjs` + 全量测试日志 `test-full.log`，均已等比缩至最长边 1280px / 原始未缩图留存 `/tmp/qa281-reverify/shots/`）。

---

## 种子数据

登录态为本地首注册管理员（首用户免邮箱验证）。经 write token `POST /api/write/pages` 播种六级树：

| 页 | id | 标题 | 层级 |
| --- | -- | ---- | ---- |
| A | 1 | 1.0 根页面 | 0 |
| B | 2 | 2.0 一级子页面 | 1 |
| C | 3 | 3.0 二级子页面 | 2 |
| D | 4 | 4.0 这是一个用于验证移动对话框长标题溢出修复的被移动页面标题特别长会溢出吗☆ | 3（长标题） |
| **E** | **5** | **5.0 二级长标题待移动页——移动对话框长标题穿模修复复验用页面标题也是相当的长☆** | 4（长标题，**被移动页/被删页**） |
| F | 6 | 6.0 短标题回归页 | 4（D 之下，#279 回归用） |

场景 A 打开 `/p/5` 的移动对话框：标题为 `移动「5.0 二级长标题待移动页——移动对话框长标题穿模修复复验用页面标题也是相当的长☆」`（607px 文本宽）；场景 B 打开同一页的删除对话框：`删除「5.0 …」？`（621~624px 文本宽）。主题经 `PUT /api/me/theme-style` 设服务端风格真源 + localStorage `ciki-theme` 镜像明暗，每组合落位后断言 `data-theme` / `.dark` 均匹配。

## 一、逐项签收表

| # | 验收标准 | 测法 | 结果（实测） | 判定 | 证据 |
| --- | -------- | ---- | ------------ | ---- | ---- |
| 1 | **被移动页自身长标题**：对话框无溢出、标题单行省略号截断、悬停可读完整标题 | `/p/5` 更多 → 移动，8 组合（nova/paper × light/dark × 1280/500）量测 + 截图 | `dlgOverflowX=0`、`pageOverflowX=0`；grid 单列轨道 = 内容盒（416/416 @1280、436/436 @500，零越轨）；标题 `rectH=lineH`（14/14px）单行、`text-overflow:ellipsis` + `overflow-x:hidden`、`scrollW 607~609 > clientW 392/412` 截断生效；`title` 属性 === 完整标题（8/8 组合）；标题/描述/页脚均在对话框与视口内 | **通过** | `long-*-move-closed.png` ×8、`*-move-title-hover.png` ×8；`results.json`（move-closed 各项） |
| 2 | **PageView 删除对话框（同族）**长标题：同口径 | `/p/5` 更多 → 删除，同 8 组合 | `dlgOverflowX=0`、轨道=内容盒（352/352 @1280、288/288 @500）；标题单行（21/21px）、ellipsis+hidden、`scrollW 621~624 > clientW 352/288`；`title` 属性 === 完整标题（8/8）；destructive「移入回收站」+「取消」在框内视口内 | **通过** | `long-*-delete-closed.png` ×8；`results.json`（delete-closed 各项） |
| 3 | **主题矩阵目检**：浅色/暗色 × nova/paper × 窄屏(<640) | 36 张截图逐张人工目检（含 1280 桌面态） | 4 风格×明暗 × 双视口：对话框无溢出、省略号正确、暗色/浅色/双风格渲染正常；500px 下页脚按钮堆叠为双列、均在框内；`data-theme`/`.dark` 断言 10/10 组合匹配 | **通过** | `qa/qa281-reverify-evidence/` 全部 36 张（抽检见 `long-nova-dark-500-move-closed`、`long-paper-dark-500-delete-closed`、`long-nova-light-500-move-open`、`short-paper-dark-500-move-open`） |
| 4 | **#279 不回归**：trigger / dropdown / indent | `/p/6`（短标题，nova-light-1280 + paper-dark-500）+ `/p/5`（长标题 8 组合）打开父页下拉 | 触发器值内层 span `clipped=true` + ellipsis、触发器不出表单列（10/10）；下拉面板 `overflowX=0`、`maxW=calc(100vw-2rem)`（1248/468px）、视口内（10/10）；缩进 `padding-left = depth×18` → 0/18/36/54/72px 步长一致（10/10）；长标题选项（4.0/5.0）视觉带省略号、面板无横向溢出 | **通过** | `long-*-move-open.png` ×8、`short-*-move-open.png` ×2 |
| 5 | 全量测试与 CI 绿 | 本地 `pnpm test` 全量 + CI run 核对 | worker 主套件 **856/856** + workerd 套件 **23/23** + web **1282/1282** = **2161 全过 0 失败**；CI Validate `46128151072` success、deploy `46128318236` success（headSha 均 `8679061`） | **通过** | `qa/qa281-reverify-evidence/test-full.log`；gh run 记录 |

## 二、关键量测摘录（原始值见 `results.json`）

| 场景 | 组合 | 对话框宽 | 轨道/内容盒 | 标题 scroll/client | title 属性 |
| --- | --- | --- | --- | --- | --- |
| 移动 @1280 | 4 风格×明暗 | 448（sm:max-w-md） | 416 = 416 | 607~609 / 392 | 8/8 = 完整 |
| 移动 @500 | 4 风格×明暗 | 468（calc(100%-2rem)） | 436 = 436 | 607~609 / 412 | 8/8 = 完整 |
| 删除 @1280 | 4 风格×明暗 | 384（sm:max-w-sm） | 352 = 352 | 621~624 / 352 | 8/8 = 完整 |
| 删除 @500 | 4 风格×明暗 | 320 | 288 = 288 | 621~624 / 288 | 8/8 = 完整 |
| 移动 短标题 | 2 组合 | 448 / 468 | = 内容盒 | 392/392、412/412（未截断，无误伤） | = 完整 |

## 三、测试方法记录项

- **环境**：`wrangler dev :8787`（`--var APP_VERSION=v1.0.0-336-8679061-qa281`、`--persist-to /tmp/qa281-reverify/state` 独立 state；`.dev.vars` 本地生成，测毕已删除）+ `vite dev :5173`。两服务以 `qa281-worker` / `qa281-web` 留在本机 services，复核后可停止。web 前端为 vite dev 直服被测工作区源码（`git status` 干净）；布局类名 dev/prod 一致（Tailwind），生产构建已由 CI build 步骤覆盖。
- **量测口径 1（SelectValue 裁剪）**：首轮按容器 `[data-slot="select-value"]` 判裁剪报 10 条「未裁剪」——核对 DOM 后确认 SelectValue 是 `min-w-0` flex 容器（值不溢出），ellipsis 承载在内层 `span.block.truncate`（缩进 padding 也在此层）；口径改为内层 span 后 `clipped=true` 全过。**脚本侧误报，非产品缺陷。**
- **量测口径 2（下拉选项溢出 itemOv）**：500px 下 4.0/5.0 长标题选项 `scrollWidth>clientWidth` 判 true——这是截断生效的技术表现（`overflow-x:hidden` + 视觉省略号已在截图确认，`long-*-500-move-open.png`），断言口径为「无视觉溢出 + 面板无内部横向溢出（`listboxOverflowX=0`）」，通过。
- **量测口径 3（缩进首项 -6）**：首项「顶层（无父页面）」标题 span 无内联 padding（非树节点），回退量到 option 本体 `pl-1.5=6px`，与首个树节点（0px）形成 −6 差；树节点缩进步长 18px（`row.depth * INDENT_WIDTH`，`MovePageDialog.tsx:208`）严格一致。#279 缩进口径不回归。
- **悬停可读口径**：`title` 原生浮层为浏览器级行为，headless 截图不含浮层渲染；以属性级验证为准（8+2 组合 `title` 属性均 === 完整标题），另附悬停态截图（光标置于标题上，布局无变化、无溢出）。属性即原生浮层的内容来源，与 #280 同法。
- **浏览器矩阵**：每组合独立浏览器实例；`pageerror` 监听全程 0 条；主题落位断言（`data-theme` + `.dark`）10/10 组合匹配。
- **测前基线**：`git diff` 核对被测工作区与 #281 合入内容一致（详见报告头）；上轮 #280 的量测脚本（`/tmp/ciki-verify/verify.mjs`）作为方法基座，按本单口径改写为 `verify281.mjs`（随证据入库）。

## 四、失败项 / 未覆盖项 / 遗留

- **失败项**：无。28 项量测最终 0 失败（过程口径修正 3 条均记录于上节，不涉产品代码）。
- **未覆盖项**：真实鼠标悬停的原生浮层视觉（浏览器 chrome 级，无头不可渲染）——以属性级验证 + 悬停截图替代，与 #280 口径一致；触屏真机不作验收门槛（承前口径）。
- **遗留**：无新增。#280 打回的两处残留均确认闭合。
