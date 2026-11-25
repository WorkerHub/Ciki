# QA #229 · 编辑工具条段落样式标签初始化抖动 — Jim 真跑验收报告

- 被测实现：PR #284（squash → `b4ca909`，生产 deploy run 45596214067 已上线）
- 工单：#229（验收 #210 修复）；口径由指挥官定版，四项逐项真跑
- 测试执行：Jim（本会话），全部为真实浏览器（Chromium via playwright-core 1.65.1）零交互/真实交互采样，无任何放水
- 结论先行：**❌ 打回 —— 口径 1 不达标：初始标签存在高概率随机「标题 2」，本地生产构建 8/20~10/12、vite dev 2/12 复现；且已定位根因（加载竞态 + baseline 哨兵缺陷），修复方案未覆盖该路径**

---

## 一、逐项签收表

| # | 验收口径 | 测法 | 结果 | 证据 |
|---|---|---|---|---|
| 1a | 生产构建多次重载，初始标签稳定一致、无随机「标题 2」 | 12 次重载编辑页，`addInitScript` 于文档脚本前注入 rAF 逐帧采样 4s/次 | **PASS（12/12）**：每次 distinct 恒 `["正文"]`，首帧窗口 1229–2690ms | `results-prod.json`（reloadResults） |
| 1b | 本地生产构建（`pnpm build:web` + wrangler dev 9221，HEAD=b4ca909）多次重载 | 同法 10 次（首轮）+ 20 次专项取证 | **FAIL**：首轮 2/10 命中；取证 8/20（40%）命中。命中 run **首个样本帧（356–408ms）即为「标题 2」并恒定 188–191 帧全程**，从未显示「正文」；`activeElement=body`（零交互、无 focus 事务） | `results-local-build.json`、`capture-local-build.json`、`shots/capture-local-build-hit*.png`（8 张，含指纹 `Ciki · 1.0.0 · b4ca909+build.298`） |
| 1c | vite dev（5174 源码态，/api 代理 9221）多次重载 | 同法 12 次 | **FAIL**：采样 #3 命中（431ms 起 217 帧恒「标题 2」） | `results-vite-dev.json` |
| 2a | 点进正文段 → 显示「正文」 | 真实点击 `heading` 内 + 点正文段后读标签 | PASS（三环境全过） | results-*.json 口径2a |
| 2b | 点进标题 → 显示对应层级 | 点文首 h2 | PASS（三环境全过） | 口径2b |
| 2c | 切段落样式 → 标签正确跟随 | 下拉切「标题 3」，断言标签=标题 3 且文档块变 h3 | PASS（三环境全过） | 口径2c |
| 2d | 切回正文 → 还原 | 切「正文」，断言标签=正文且 h3 还原为段落 | PASS（三环境全过） | 口径2d |
| 3a | ⌘S 保存内容落库 | ⌘S 后 GET `/api/pages/:id?format=json` 断言标记 | PASS（本地构建、vite dev、生产均过） | 口径3a |
| 3b | 保存生成版本记录 | GET `/api/pages/:id/revisions` | PASS（本地 revisions=4） | 口径3b |
| 3c | 保存按钮回阅读页 | 点击保存按钮断言 URL | PASS | 口径3c |
| 3d | 阅读页呈现保存内容 | 等 `.ProseMirror` detach 后断言 R1/R2 文本 | PASS | 口径3d |
| 4a | light 主题主路径 | 切 light 后初始标签 + 点进标题跟随 | PASS（三环境全过） | `shots/*light-*.png` |
| 4b | dark 主题主路径 | 切 dark 后初始标签 + 点进标题跟随 | PASS（三环境全过） | `shots/*dark-*.png` |

汇总：生产 28/28；本地生产构建 23/26（口径 1 三项 FAIL）；vite dev 26/28（口径 1 两项 FAIL）。**口径 2、3、4 全部达标；唯一不达标的是口径 1，且在生产环境低时延竞态窗口未开时表现为「未复现」**。

## 二、口径 1 失败机制（探针实证，非推测）

两环境（本地构建 9221、vite dev 5174）注入事务探针：`dom.editor`（tiptap 将实例挂到 `.ProseMirror.editor`，@tiptap/core:6958）订阅全部事件 + 包装 `fetch` 记录页面/空间两请求完成顺序 + MutationObserver 记录标签首帧：

**local-build 12 run：10 HIT / 2 pass，12/12 相关；vite-dev 8 run：2 HIT / 6 pass，8/8 相关。** 相关性结论：

1. **「标题 2」命中 ⇔ `/api/pages/:id` 先于 `/api/spaces` 完成**（local-build run1: 494<512；vite run2: 591<597）。两个 PASS 例是同毫秒完成但日志序 spaces 在前。
2. 命中 run **编辑器实例上零事务事件**（`fn` 只订阅 `transaction`/`update`；仅观察到 `create`，不触发计数）——翻转不需要任何用户事务。
3. 首帧标签观察：HIT run 首帧即「标题 2」且此时 `dom.editor` 的 doc 首块已是 heading；PASS run 首帧「正文」。

### 机制链

1. `PageEdit.tsx:277`：`loading || spacesStatus === "loading"` 时渲染骨架屏——`ParagraphStyleMenu` 未挂载；但 `useWikiEditor`（`Editor.tsx:216`）`immediatelyRender` 默认 true，**挂载即无条件创建空文档编辑器 A0**。
2. 页面数据先到：`content` memo 变化 → `useEditor` deps 换手（passive effect）A0→B（真实内容实例）；spaces 后到：门控才打开 → **`ParagraphStyleMenu` 首次挂载时拿到的 editor 已经是 B**。
3. `ParagraphStyleMenu.tsx:52-54`：`baseline` 初值 `{editor, tx: -1}`——首挂即 B 时直接记为 `{B, -1}`；此时 tx=0（B 无任何事务）。
4. `ParagraphStyleMenu.tsx:70-71`：`isSettled = baseline.editor === editor && tx > baseline.tx` → `0 > -1` **恒真** → 首帧即如实反映 B 的选区——B 的初始 selection 是文档起点（ProseMirror 默认 `Selection.atStart`），首块是 h2 → 标签「标题 2」。
5. 对照路径（修复按设计工作）：spaces 先到 → menu 首挂 A0（空文档 heading="p"，`{A0,-1}` settled 但值为正文）→ 换手 render `setBaseline({B, 0})` → `0 > 0` false → 未落定 → 正文。

**结论：`-1` 哨兵只防「换手后旧快照闪现」（#210 原始症状），防不住「首挂即见内容实例」——守卫在这条路径上从未生效。** 该路径不需要旧实例快照参与，所以注释里「transactionNumber 跨实例不重置」的假设之争与本 bug 无关。

### 为什么生产 12/12 未复现

生产 `/api/pages/409?format=json`（payload 大 + 网络 RTT）完成时间远晚于 `/api/spaces`（~50ms 级，且常被应用壳层预热），恒走安全路径。本地两请求都在 10–30ms 内完成，完成次序随机 → 硬币翻转。**这是被网络时延掩盖的同源竞态，不是「生产不存在此 bug」**——慢客户端、CDN 未预热、页面 payload 增大（长文/大图）都可能让生产窗口打开。

## 三、复现路径（最小）

1. 任意含文首标题的页面，直开编辑页（`/p/:id/edit`）；
2. 保证 `/api/pages/:id?format=json` 响应早于 `/api/spaces`（本地/快速网络下约 40–90% 概率自然发生；也可用代理给 `/api/spaces` 加 ≥50ms 延迟稳定触发）；
3. 零交互观察工具条段落样式下拉：首帧即「标题 N」（N=首块层级），持续到首次交互前恒定。

## 四、修复方向建议（不代修，供修复人参考）

哨兵语义缺陷：`tx: -1` 把「首次挂载即见到编辑器」当作已落定。落定信号应表达「**当前实例至少发生过一笔事务**」，例如 baseline 记 `{editor, tx}` 且初值 `tx: 0`、以 `tx > baseline.tx` 为落定（首挂 B：`0 > 0` false → 正文，直到真实事务或 onCreate/onMount）；或以实例的 `isInitialized`（mount 的 `setTimeout(0)` 后置位）作为附加条件。同时建议修复人评估：`PageEdit.tsx:92` 的 `contentJson: page?.contentJson ?? ""` 与 `PageEdit.tsx:277` 门控分离导致「A0 空实例先行」本身是竞态温床（可让编辑器延后到 page 就绪再创建）。

## 五、测试环境与数据

- 生产：`https://ciki.oneboy.app`，QA 铸号 user id=18304 / space id=8 / page id=409（文首 h2 + 两段正文，标记 `QA229-SAVE-BASE`），真实登录接口会话注入
- 本地构建：worktree HEAD=`b4ca909` clean，`pnpm build:web`（build-info `v1.0.0-298-b4ca909`），wrangler dev 9221（`--persist-to /tmp/ciki-qa229/state`，APP_VERSION 自证 `v1.0.0-298-b4ca909-qa229`）
- vite dev：`web/node_modules/vite.qa.config.mts`（5174，/api → 9221），源码态
- 采样判定：combobox `[aria-label="段落样式"]` 内 `[data-slot]` 文本；「标题 2」是工单目标抖动值，光标默认落文档起点（h2 内）时如实反映即记「标题 2」
- 全部证据见 `qa/qa229-evidence/`：results-*.json（逐项 PASS/FAIL 与采样明细）、capture-local-build.json（20 run 逐帧 + active/h2）、capture-tx-*.json（两环境事务探针）、shots/（29 张）、scripts/（脱敏版）
- QA 数据只提交本单会话分支，不进 main；生产残留（页 409、空间 8、用户 18304 及会话行）测后清理，见清理记录
