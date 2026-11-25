# QA #232 二轮复验报告：编辑工具条段落样式标签初始化抖动

- **执行**：Jim（QA 角色）
- **日期**：2026-11-25
- **被测版本**：二轮修复 `ff5ff3b`（二轮改动：哨兵初值 `tx:-1` → `tx:0`，「编辑器延后创建」方案不采纳）
- **结论**：**签收通过**。三环境 × 主套件 26/26、强制竞态 12/12，全部通过；生产数据终局拆除，残留核验 0。

---

## 一、环境与被测对象自证

| 环境 | 地址 | 版本自证 | 备注 |
|---|---|---|---|
| 生产 | https://ciki.oneboy.app | `/api/public` → `v1.0.0-299-ff5ff3b`（无后缀） | deploy run 45621040797 success、head_sha=ff5ff3ba…（gh api 核验）；测试页 id=410（QA 铸造，文首 h2 + 两段落） |
| 本地生产构建 | 127.0.0.1:9221（wrangler dev + 已构建 dist） | `v1.0.0-299-ff5ff3b-qa232`（-qa232 后缀证明为本机实例） | 本地 D1（ciki_ 前缀）、本地测试页 id=1 |
| vite dev | localhost:5174（源码态） | 经代理自证同上 | 临时配置 `web/node_modules/vite.qa.config.mts`（不进仓库），/api 代理 → 9221 |

测试页内容三环境一致：`## QA232 标题开头` + 两个正文段落（首轮口径：文首标题）。
登录态：QA 临时账号 `qa232@ciki-qa.test`（生产 id=18305，本地 id=1），UI 真实登录取得会话后采样。

## 二、测法

- playwright-core 1.65.1 + Chromium for Testing 1255（首轮同机同款），headless，1440×900。
- `context.addInitScript` 在**文档脚本执行前**注入 rAF 逐帧采样器：读 `[aria-label="段落样式"]` 文本（含 `[data-slot]` 子节点），**零交互**，覆盖编辑器初始化全程。
- 自适应采样窗：注入点起采样，工具条首见后续采 3s；15s 仍无工具条记 `noToolbar`（判失败）。首轮固定 4s 窗在冷启动下出现过「窗口内 0 样本」的测量伪影（无任何错误标签），本轮改为自适应窗消除该伪影。
- **强制竞态**（本单新增，非首轮工装）：页内 JS 覆盖 `fetch` 给 `/api/spaces` 注入 300ms 延迟，令「页面数据先到、空间数据后到」**确定性成立**（首轮报告第三节建议之法）；钩子生效性用「钩内 fetch 耗时 ≥300ms + 无钩对照」双向核验。不碰产品代码、不改服务端。

## 三、逐项签收表（口径 2026-11-25 定版）

| # | 验收标准 | 测法 | 结果 | 证据 |
|---|---|---|---|---|
| 1a | 生产多次重载编辑页，初始标签稳定一致、无随机「标题 2」 | 10 次重载，逐帧采样（182–183 样本/次），零交互 | **PASS** | `results-prod.json`：10 次 `distinct=["正文"]`，首见 1335–3528ms，全程无杂音 |
| 1b | 本地生产构建同口径 | 同上 | **PASS** | `results-localbuild.json`：10 次 `distinct=["正文"]`（首轮此环境 8/20 命中「标题 2」） |
| 1c | vite dev 同口径 | 同上 | **PASS** | `results-vitedev.json`：10 次 `distinct=["正文"]`（首轮 2/12） |
| 1d | 强制竞态（/api/spaces 延迟 300ms）× 三环境 | 每环境 12 次重载 | **PASS** | `race-prod.json` / `race-localbuild.json` / `race-vitedev.json`：各 12/12 `distinct=["正文"]`；钩子核验：钩内 301–303ms ≥ 300ms |
| 2a | 点进正文 → 显示「正文」 | 点击 `.ProseMirror p` 后读标签 | **PASS** | 三环境 `口径2a`：label=正文 |
| 2b | 点进标题 → 显示对应层级 | 点击 `.ProseMirror h2` 后读标签 | **PASS** | 三环境 `口径2b`：label=标题 2 |
| 2c | 下拉切「标题 3」→ 标签跟随 + 文档出 h3 | listbox 选「标题 3」 | **PASS** | 三环境 `口径2c`：label=标题 3 且 h3=true |
| 2d | 下拉切回「正文」→ 标签跟随 + h3 还原 | listbox 选「正文」 | **PASS** | 三环境 `口径2d`：label=正文 且 h3Gone=true |
| 3a | ⌘S 保存落库 | ⌘S 后 `GET /api/pages/:id?format=json` 读回 | **PASS** | 三环境 `口径3a`：contentText 含追加标记 |
| 3b | 保存生成版本 | `GET /api/pages/:id/revisions` | **PASS** | 三环境 `口径3b`：revisions≥2 |
| 3c | 「保存」按钮 → 回阅读页 | 点按钮后 waitForURL | **PASS** | 三环境 `口径3c`：URL 落 `/p/:id`（无 /edit） |
| 3d | 阅读页呈现保存内容 | 卸载编辑器后等文本可见 | **PASS** | 三环境 `口径3d`：R1/R2 标记均可见 |
| 4a | light 主题主路径 | `data-mode=light` 下：初始标签 + 口径 2 全链 | **PASS** | 三环境：light 初始 `["正文"]`，2a/2b/2c/2d 全过；截图 `shots/*-light-*.png` |
| 4b | dark 主题主路径 | `data-mode=dark` 下：初始标签 + 点标题跟随 | **PASS** | 三环境：dark 初始 `["正文"]`，点 h2 → 「标题 2」；截图 `shots/*-dark-*.png` |

**汇总**：生产 26/26、本地生产构建 26/26、vite dev 26/26（各含口径 1–4 全部检查项）；强制竞态三环境各 12/12。**无失败项**。

## 四、复现路径（首轮 FAIL → 本轮 PASS 对照）

| 环境 | 首轮（tx:-1） | 二轮（tx:0） |
|---|---|---|
| 生产 | 12/12 未复现（28/28 PASS） | 10/10 + 竞态 12/12 稳定 `正文` |
| 本地生产构建 | **8/20 命中「标题 2」** | 10/10 稳定 `正文`，竞态 12/12 |
| vite dev | **2/12** | 10/10 稳定 `正文`，竞态 12/12 |

机制注解（与 Mary 二轮说明一致）：哨兵初值 `tx:-1` 下，空文档实例的首笔本地事务（`tx:0`）即满足 `tx > baseline.tx`，工具条挂载时锁在「标题 2」的陈旧标签上；`tx:0` 后须等**内容实例的真实事务**（`tx ≥ 1`）才落定，配合 `PageEdit.tsx:277` 门控 + 编辑器先跑空实例，「工具条首挂即见内容实例」路径成立。强制竞态证明该落定不依赖「页面/空间接口到达顺序」。

## 五、数据拆除与残留核验

生产（D1 `af4434ef-…3737fe`，逐条 DELETE 按依赖序）：
- `page_revisions`(page 410, editor 18305)：5 行 ✅
- `pages`(410)、`space_members`(space 9)、`spaces`(qa232-space)、`users`(18305)：各 1 行 ✅
- 终核：用户/空间/成员/页面/修订/令牌/通知/评论/挑战/邮件码 **全部 0**；基线回到 3 用户 / 7 空间 / 383 活页（与本单开始前一致）；已删账号登录接口返回 401 ✅

本地：worker(9221)/vite(5174) 已停，D1 持久化目录、口令文件、cookie 文件已删除。

## 六、证据清单（本目录）

```
qa/qa232-evidence/
├── results-prod.json           # 生产主套件逐项结果（26 checks + apiLog + reloadResults）
├── results-localbuild.json     # 本地生产构建逐项结果
├── results-vitedev.json        # vite dev 逐项结果
├── race-prod.json              # 生产强制竞态 12 轮 + 钩子核验
├── race-localbuild.json        # 本地构建强制竞态
├── race-vitedev.json           # vite dev 强制竞态
├── shots/                      # 21 张关键截图（三环境 × light/dark/保存前后）
└── scripts/
    ├── lib.mjs                 # 启动参数（Chromium 1255、代理 bypass localhost）、cookie 解析
    ├── run-main.mjs            # 主套件（口径 1–4）
    └── run-race.mjs            # 强制竞态（/api/spaces 300ms 延迟钩子 + 生效核验）
```

复跑：`node qa/qa232-evidence/scripts/run-main.mjs <base-url> <origin> <page-id> <password-file>`（需先铸 QA 数据；`QA_RELOADS` 控重载次数，默认 10）。

## 七、QA 红线自检

- 未改任何产品代码；本地环境用未跟踪文件（`.dev.vars`、`web/node_modules/vite.qa.config.mts`）+ 页内 JS 钩子实现，不进 main。
- 未代实现者修 bug；仅按口径真跑采样与交互验证。
- 证据只落本工单分支（`tds/conv-01a212db-…`），不进 main。
