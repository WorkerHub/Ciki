# QA #222 验收报告：纸面亮色代码块浅色配色

- 验收单：todo #222（qa/theme）；实现单：todo #220
- 被测实现：分支 `tds/conv-01a2112b-ae5a-7ae6-a815-b91a2fad88db`，commit `4fef8f9`（`fix(theme): use warm light paper palette for code blocks`）
- 变更范围核对：`git diff e41b65a..4fef8f9` 仅 `web/src/index.css`，7 行令牌替换（纸面亮色段）
- 验收人：Jim（真跑验收），日期 2026-11-25

## 验收环境与方法

- 本地全栈：`wrangler dev --port 8788`（worker 直接服务 web/dist 产物，接近部署形态），D1/R2 本地 state，迁移 v1→v13，数据 seed 一次贯穿改前/改后两轮
- 种子内容：页面 id=1「代码块配色验收页」（正文 TS 折叠块 interface/泛型/async、Python 块、表格含单元格内 JSON 代码块与行内代码）、评论 id=1（ts 代码围栏 + 行内代码）
- 操作路径全部走真实 UI：`/login` 表单登录 → `/settings` ToggleGroup radio（role=radio）+ 保存按钮（仅 dirty 时可用）→ 顶栏主题循环按钮（auto→浅→深）切亮暗；Playwright（chromium headless 1440×900）`getComputedStyle` 实测 + 整页/局部截图
- 改前基线：同一脚本、同一数据在 `e41b65a` 构建重跑（改前截图页脚 build 与改后不同，CSS 指纹 `index-CYhAQWCH.css`）

## 逐项签收

### 1. 纸面亮色：代码块浅色暖纸底、深色字、语法角色可区分（含评论围栏 / 表格单元格 / 编辑器）— PASS

实测（computedStyle，页面 `data-theme=paper` `data-mode=light`）：

| 令牌 | 声明值 | 实测解析 |
|---|---|---|
| `--code-bg` | `#e9e3da` | rgb(233,227,218) |
| `--code-fg` | `#2a2b2f` | rgb(42,43,47) |
| `--code-dim` | `#77746f` | rgb(119,116,111) |
| `--code-kw` | `#a03e2b` | rgb(160,62,43) |
| `--code-str` | `#845312` | rgb(132,83,18) |
| `--code-type` | `#1d685c` | rgb(29,104,92) |
| `--code-border` | `rgba(42,43,47,0.08)` | rgb(223,219,210)（alpha 按纸色合成，见备注） |

同口径容器实测同一组值（bg 233,227,218 / fg 42,43,47）：正文 `.code-block`、表格 `td .code-block`、评论 `.comment-body pre`、编辑器 `/p/1/edit` 内 `.wiki-content .code-block`。hljs 角色：kw=砖红、str/number/literal=棕金、type/classTitle/builtIn/title=青绿、comment/punctuation=灰、fn/attr/variable=墨色，五类两两互异（脚本断言通过）。截图：`qa222-screenshots-after/T1-paper-light-{reading,codeblock,comment,table,editor}.png`，页脚版本 `4fef8f9+build.292`。

### 2. 纸面暗色：与改前一致（令牌未动）— PASS

前后全脚本逐值对照 **IDENTICAL**：bg #101114、fg #e9e6e0、dim #9da1b0、kw #f08a6d、str #e6c477、type #93cfc6、border #ffffff14，及全部 hljs 角色、header、td/comment 容器逐值相等。截图：`T2-paper-dark-{reading,codeblock}.png`。

### 3. Nova 亮/暗：与改前一致 — PASS

前后对照 **IDENTICAL**：亮 rgb(246,248,250)/rgb(36,41,47)，暗 rgb(22,27,34)/rgb(230,237,243)，GitHub 写死基色未受令牌影响（Nova 下 `--code-*` 计算值为空，令牌不参与）。截图：`T3-nova-{light,dark}-*.png`。

### 4. 对比度抽测（WCAG 2.1，QA 独立复算）— PASS

改后纸面亮色，bg=rgb(233,227,218)：

| 角色 | 实测色 | 对比度 |
|---|---|---|
| fg（正文） | rgb(42,43,47) | **11.09:1** ✓ |
| kw | rgb(160,62,43) | **5.12:1** ✓ |
| str | rgb(132,83,18) | **5.10:1** ✓ |
| type | rgb(29,104,92) | **5.17:1** ✓ |
| dim（实测值，不设 4.5 门槛） | rgb(119,116,111) | **3.65:1** |

与实现报告数字逐位一致。暗色侧 fg 15.16 / kw 7.70 / str 11.26 / type 10.77 / dim 7.33，全部 ≥4.5。

### 5. 主题与亮暗来回切换无残留错色块 — PASS

切换序列（每步读回 `data-theme`/`data-mode`/`.code-block` 背景）：paper 亮 → paper 暗 → nova 暗 → nova 亮 → paper 亮 → paper 暗 → nova 暗 → nova 亮 → paper 亮，9 步背景依次 `#e9e3da → #101114 → #161b22 → #f6f8fa → #e9e3da → #101114 → #161b22 → #f6f8fa → #e9e3da`，每步均与该象限期望值全等，末态与首态全等；localStorage `ciki-theme` 每步与 UI 一致，无错色残留。改前序列同构（仅 paper 亮位置为旧深色 #2d2e32），证明切换链路本身行为未变。截图：`T5-seq*.png`。

## 备注

- `--code-border` 实测 rgb(223,219,210) 非 MISMATCH：声明为 8% alpha 墨色，浏览器返回按底色合成后的值，令牌已正确应用（暗色侧 #ffffff14 同理合成）。
- dim 3.65:1 低于 4.5，口径为「注释等弱化角色给实测值」，与实现口径一致；正文/关键字/字符串/类型均达标。
- 验收过程曾出现一次脚本自身缺陷（设置页双保存按钮定位、radio 已选中时点击导致保存按钮不 enable），已修正脚本并以 aria-checked 防御；均为验收工具问题，与被测实现无关。

## 结论与声明（≤500 字）

**结论：PASS（5/5 项全过）。**

1. 纸面亮色 PASS——正文/表格单元格/评论围栏/编辑器四类容器实测同口径：暖纸底 #e9e3da、墨字 #2a2b2f，kw #a03e2b、str #845312、type #1d685c、dim #77746f 五类语法角色色两两互异，截图确认视觉形态正确。
2. 纸面暗色 PASS——前后基线逐值对照 IDENTICAL（7 令牌 + 全部 hljs 角色 + 头部/容器）。
3. Nova 亮/暗 PASS——前后对照 IDENTICAL，GitHub 基色与令牌隔离正确。
4. 对比度 PASS——QA 独立复算 WCAG 2.1：fg 11.09:1、kw 5.12:1、str 5.10:1、type 5.17:1，均 ≥4.5:1；dim 实测 3.65:1（弱化角色，口径内）。
5. 切换残留 PASS——paper/nova × 亮/暗 9 步来回切换每步背景值与期望全等，末态=首态，localStorage 同步无错色。

被测 commit 4fef8f9 变更面（仅 index.css 纸面亮色段 7 令牌）与行为完全吻合，未发现回归。

**本单已交付、请置完成。**

## 证据文件清单

- `qa222-qa-values.mjs`——抓值脚本（可复现，参数：输出 json / 截图目录 / 邮箱）
- `qa222-values-after.json` / `qa222-values-before.json`——改后/改前全量 computedStyle 数据
- `qa222-screenshots-after/`——14 张（T1×5、T2×2、T3×4、T5×3）
- `qa222-screenshots-before/`——3 张改前对照（阅读页/代码块特写/编辑器，旧深色形态）
