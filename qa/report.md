# #224 非法 theme 线上直写复核：production 登录页 Jim 真跑

- 时间：2026-11-25 06:54–06:55 UTC（单轮真跑，7/7 PASS，无重试、无挑选）
- 被测：`https://ciki.oneboy.app/login`（**production**，全程未登录、未提交任何表单）
- 方法：playwright-core 1.65.1 + 本机 chromium headless（chromium-1255）；持久化 profile（`/tmp/ciki-qa-224/profile`）真实直写 localStorage → `page.reload()` 真刷新；系统配色模拟 `prefers-color-scheme: dark`（让 auto 与 light 的解析结果可区分），locale en-US
- 工具脚本：`qa/run.mjs`；全程明细：`qa/results.json`、`qa/run-log.txt`；截图：`qa/shots/`（7 张）

## 0. 被测版本指纹链（只读核对）

| 证据点 | 值 |
|---|---|
| `GET /api/public`（跑前+跑后一致） | `v1.0.0-295-09688fc` |
| 登录页 AuthShell 页脚（全部 7 次观测一致） | `Ciki · v1.0.0-295-09688fc` |
| git | `09688fc` = origin/main HEAD（#281），`git merge-base --is-ancestor 65c69e0 09688fc` = 是，修复提交 `65c69e0`（#279）的 rehydrate 校验代码在该 commit 上完好 |

**与 Spec 事实的偏差（代码与事实为准）**：Spec 写生产指纹 `v1.0.0-293-65c69e0`（#223 当时快照）。本轮实测生产已前进到 `v1.0.0-295-09688fc`（#280、#281 先后部署），该 commit 是修复提交的后代，修复确实在线上。#223 在 293 上的 48/48 结论与 #224 在 295 上的直写复核互为补充，均通过。

## 1. 逐项签收

| # | 验收项（标准） | 测法 | 结果 | 证据 |
|---|---|---|---|---|
| ① | production 登录页直写字段互换非法值 → 刷新不崩（无 `Unexpected Application Error!` 错误页），theme 回退 auto、style 回退 nova | 两种形态各直写一次后真刷新：spec 字面扁平 `{"theme":"paper","style":"light"}`（case1a）；zustand 真实落盘/12-12 崩溃形态 `{"state":{"theme":"paper","style":"light"},"version":0}`（case1b）。dark 系统下 `data-mode=dark` + 按钮 `Theme: Auto` 即 auto 生效之证；`data-theme=nova` 即 style 回退之证 | **PASS ×2** | `shots/case1a.png`、`shots/case1b.png`（深色登录页、右上角显示器图标、页脚指纹）；`results.json` case1a/case1b |
| ② | production 登录页直写非法 style 值 → 不崩，style 回退 nova、theme 保留 light | 同上双形态：扁平 `{"theme":"light","style":"paperx"}`（case2a）；包裹层 `{"state":{"theme":"light","style":"paperx"},"version":0}`（case2b）。dark 系统下 `data-mode=light` + 按钮 `Theme: Light` 即 light 未被吞之证；`data-theme=nova` 即 style 回退之证 | **PASS**（case2b 落标准；case2a 见 §2 说明） | `shots/case2b.png`（浅色登录页、太阳图标）vs `shots/case1b.png`（深色）同屏对比；`results.json` case2a/case2b |
| ③ | 清理：删除写入的 `ciki-theme`，恢复 production 域 localStorage 原状 | 基线快照 = 写入前全量键值（本次为空 `{}`）；测毕 `localStorage.clear()` 后逐键还原，刷新复核：localStorage 仍等于快照、`ciki-theme` 不存在、页面正常 | **PASS** | `shots/final-cleanup.png`；`results.json` cleanup（restored={} 与 baseline={} 逐键相等，ciki-theme=null） |
| 附 | 健壮性加测：非法 JSON 裸字符串 `paper` 直写 → 不崩、回退 auto/nova | 同法直写+刷新 | **PASS** | `shots/case3.png`；`results.json` case3 |

断言均为结构化检测，不是文本扫描：崩溃=react-router 8.5.1 默认错误边界的 `<h2>` 精确等于 `Unexpected Application Error!`（吸取 #223 教训）；另全程捕获 pageerror（0 条）与 console error（仅登录前 `/api/me`、`/api/auth/refresh` 401 探活，每轮 2 条，按 #211/#223 先例豁免并逐条留档，无其他错误）。

## 2. 如实记录：spec 字面写法与真实落盘格式的语义差

`index.html` 首屏内联脚本按 `parsed?.state?.theme ?? parsed` 解析（`web/index.html`）。**扁平格式**（spec 字面 `{"theme":"light","style":"paperx"}`）不是 zustand persist 的落盘格式：`parsed.state` 不存在，theme 取整个对象判非法 → auto；store 侧 merge 无操作 → 默认 auto/nova。因此 case2a 中 theme=light 无法保留（回退 auto），这不是缺陷而是解析语义。**「style 回退 nova、theme 保留 light」的验收实质由包裹层形态（case2b）闭环**——那才是真实用户 localStorage 的形态（12-12 崩溃同源）。两种形态均不崩。

另：未登录页面 rehydrate 校验不触发 `set()`，刷新后 localStorage 里的非法原值不会被改写（原样保留），回退语义体现在 store/DOM（`data-theme`/`data-mode`/循环按钮图标）。用户下次通过 UI 切档即被归一覆盖。

## 3. 约束遵守

- 只测 production 登录页（未登录可达），未登录、未写任何线上数据；对生产域仅 localStorage 直写且测毕恢复原状（§1 ③）
- 未起本地栈、未测分支；生产域无服务端副作用（仅 GET /api/public、登录前探活 401）
- 本报告与证据只落工单分支 `qa/`，不进 main；Jim 未改任何产品代码
- 密钥卫生：无任何口令/令牌参与本单；截图仅含登录页公开 UI
