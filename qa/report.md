# 工单 #223 · 非法 theme 崩溃修复 · 线上快速回归（Jim 真跑）

**结论：验收通过（48/48 PASS）。** 修复 commit `65c69e0`（PR #279）在真实浏览器中验证：预置非法 `ciki-theme` localStorage 后应用不崩溃、主题回退语义正确、合法值行为不变；编辑页与读页均复测不崩。

- 验收人：Jim（QA，只测不改）
- 日期：2026-11-25
- 被测：Ciki web @ `65c69e0`（main HEAD，PR #279）

## 1. 被测构建与指纹链

| 环节 | 值 | 说明 |
|---|---|---|
| 修复 commit | `65c69e0` | `fix(web): validate theme and style on rehydrate to prevent react 130 crash (#279)`，main HEAD |
| 生产指纹 | `v1.0.0-293-65c69e0` | `ciki.oneboy.app/api/public` 核对，与本地 `git describe`（v1.0.0-293-g65c69e0）同 commit |
| 本地验证栈 | `http://127.0.0.1:9531` | wrangler dev，同 worktree（HEAD=65c69e0）`pnpm build:web` 产物，`--var APP_VERSION:v1.0.0-293-65c69e0`；`/api/public` 指纹与生产一致；页脚渲染 `Ciki · v1.0.0-293-65c69e0`（见 login-swap.png） |
| 口径说明 | — | 生产注册关闭（REGISTRATION_DISABLED），沿用 #194/#211/#213 先例：生产只读指纹核对 + 本地同 commit 栈真跑 |

## 2. 环境与账号

- 账号 `qa223@example.com`（本地栈注册，role=admin，themeStyle=nova）。**口令不落档**：仅存 `/tmp/qa-223.pw`（0600），脚本运行时读取，不入库、不入日志、不入工单。
- write token（id=1）经 `POST /api/me/tokens` 创建，仅存 `/tmp/qa-223/wt.txt`（0600），同样不落档。
- 测试页：id=1（`/p/1` 读页、`/p/1/edit` 编辑页），标题《非法 theme 回归验收样例（#223）》，6 个段落 × 5 个小节，足够触发阅读视图与编辑器加载。
- 浏览器：Playwright 1.65.1，chromium（chromium-1255）全量；webkit（webkit-2388）抽测项 1 两页。

## 3. 逐项签收表

| # | 验收标准 | 测法 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 非法 theme（字段互换 `{"theme":"paper","style":"light"}`，即原 12/12 复现形态）：不崩溃，theme 回退 auto，style 回退 nova | 预置 zustand persist JSON 至 `ciki-theme`，登录态直达读页+编辑页（chromium）及读页+编辑页（webkit 抽测）；断言无错误页结构、无 pageerror/#130、无计划外 console error；DOM `data-theme=nova`（auto 跟随系统=亮）；ThemeCycleButton 健康渲染；正文/编辑器加载 | **PASS**（cr+wk × 读/编 共 16 检查） | shots/s1-read.png、s1-edit.png（wk 同断言过）；results.json `cr-s1-*`/`wk-s1-*` |
| 2 | 非法 style（`{"theme":"light","style":"paperx"}`）：不崩溃，style 回退 nova，theme=light 合法值保留 | 同上，断言 `data-theme=nova` 且 `data-mode=light`（保留） | **PASS**（cr × 读/编 共 8 检查） | shots/s2-read.png、s2-edit.png；results.json `cr-s2-*` |
| 3 | 合法值行为不变：auto/light/dark 循环正常、nova/paper 风格切换正常、服务端为准、持久化正确 | 真点 UI：循环按钮 浅色→深色→自动→浅色 回环（DOM `data-mode`+`.dark` 跟随、title 文案跟随、localStorage persist 写回正确）；设置页切纸面→`PUT /api/me/theme` 200→刷新保持 paper→切回 Nova；合法 nova+light/dark+paper 预置后原样应用（登录态与路由守卫页各一） | **PASS**（11 检查） | shots/f3-cycle-dark.png、f3-settings-back-nova.png、f3-legal-paper-dark-login.png；results.json `f3-*` |
| 4 | 编辑页与读页均复测不崩 | 项 1/2/附加 全部在两种页面形态各测一遍 | **PASS** | 见上；results.json `*-read-*`/`*-edit-*` |
| 附1 | 完全非法值（`{"theme":123,"style":null}`）不崩且回退 | 同项 1 测法 | **PASS**（8 检查） | results.json `cr-s3-*`（截图与 s1 字节相同：回退后同落 nova+浅色视觉态，区分证据在 results.json 的 DOM/store 断言） |
| 附2 | 登录页（AuthShell 也挂 ThemeCycleButton）预置非法值不崩 | 未登录直达 /login（chromium × swap/badstyle） | **PASS**（4 检查） | shots/login-swap.png、login-badstyle.png；results.json `cr-login-*` |

## 4. 崩溃面核对（与修复点对应）

- `web/src/stores/theme.ts` onRehydrateStorage：theme 非法→auto、style 非 nova/paper→nova、`resolved=applyTheme` 重算 —— 源码与构建产物（`index-TzrTo54k.js` 内联）双向确认。
- `ThemeCycleButton`（`ThemeToggle-Ai2pIURH.js`）：`o=i==='light'||i==='dark'?i:'auto'` 兜底存在。
- 崩溃面组件 `AppShell.tsx:530/560` + `AuthShell.tsx:23`（登录页也挂）—— 本次对两壳都做了真跑。
- 崩溃特征文案 `Unexpected Application Error!`（react-router hooks chunk）—— 断言以「页面 h2 精确等于该文案」检测错误页结构，另捕获 pageerror/#130/Minified React error。

## 5. 已知无害现象（如实记录，非缺陷）

1. 登录前探活 `GET /api/me`、`POST /api/auth/refresh` 返回 401 —— 应用启动时的会话探测，#211 先例已确认无害；本测断言对 401 计数封顶（≤2/上下文），其余任何 console error 都判失败。
2. 未登录页 UI 语言跟随 navigator（本机 en-US 时登录页为英文）—— i18n 语言回退，与主题逻辑无关；按钮断言已做 locale 无关匹配（`主题：`/`Theme:` 双语）。
3. 测试装置说明：每轮只登录一次（storageState 复用给全部场景），避免高频登录触发服务端频控（首轮曾出现连续登录卡在 /login，裸诊断 3 连登录正常，判定为频控风险而非产品缺陷）。

## 6. 证据索引

```
qa/
├── report.md        本报告
├── results.json     48 条检查明细（id/名称/结果/detail，含每次 DOM 属性与 localStorage 采样）
├── run.mjs          真跑脚本（口令/令牌运行时从 /tmp 读取，不落库）
└── shots/           11 张截图
    ├── s1-read.png / s1-edit.png        项1 字段互换 读页/编辑页（chromium，登录态）
    ├── s2-read.png / s2-edit.png        项2 非法style 读页/编辑页
    ├── s3-read.png / s3-edit.png        附加 完全非法值 读页/编辑页
    ├── login-swap.png / login-badstyle.png  附2 登录页 AuthShell（未登录，页脚可见版本指纹）
    ├── f3-cycle-dark.png                项3 循环点击1：浅色→深色
    ├── f3-settings-back-nova.png        项3 设置页切回 Nova 后
    └── f3-legal-paper-dark-login.png    项3 合法 paper+dark（路由守卫页）
```

复跑方式：本地栈起于 `127.0.0.1:9531` 且账号/令牌文件在位时，`cd /tmp/qa-223 && node run.mjs /tmp/qa-223/results.json`（脚本见 qa/run.mjs）。

## 7. 结论

修复 `65c69e0` 通过全部验收项：非法值不崩、回退语义正确（theme→auto、style→nova）、合法值行为不变、读页/编辑页/登录页三形态复测不崩，chromium+webkit 双引擎一致。**建议关闭工单 #223。**
