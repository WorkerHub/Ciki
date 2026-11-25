# QA #200 验收报告 —— 纸面阅读列宽封顶移除（#198 修复真跑验收）

**结论：通过。**
修复版（`b0109ba`，工单分支合并提交 `6c4a7e7`，构建 `v1.0.0-285-6c4a7e7`）在宽视口下纸面主题正文列宽与 Nova 完全一致、页内导航贴画布右缘、右侧无空白；窄视口（<1280，导航整轨隐藏）除正文列宽按修复契约放大外与基线逐像素一致；颜色/字体/纹理零改动；Nova 主题全视口零变化（仅页脚构建号元数据）；编辑态几何与像素均与基线一致。基线（`563f7c0`，构建 `v1.0.0-283-563f7c0`）复现 860px 封顶与右侧空白缺陷，2400 超宽下缺陷放大（484px 空白）。

- 验收人：qa200（QA 真跑占位账号）
- 日期：2026-11-25
- 判定口径：同实例先后替换两构建真跑 + 几何量测 + 像素级 diff，非目测。

---

## 1. 被测对象与环境

| 项 | 值 |
|---|---|
| 被测修复 | #198（`b0109ba`，工单分支 `tds/conv-01a21043-…` 合并提交 `6c4a7e7`，页脚 `v1.0.0-285-6c4a7e7`） |
| 对照基线 | `563f7c0`（main 同源，页脚 `v1.0.0-283-563f7c0`） |
| 被测改动 | `web/src/index.css`（−8 行：移除 `.prose` 阅读列宽 `max-width:860px` 封顶，无例外）+ `web/src/stores/theme.test.ts`（+13 行守卫测试） |
| 实例 | 单实例 `:9210`（wrangler dev，`--persist-to /tmp/ciki-qa200/state`），先后服务基线/修复构建；每次替换后以页脚版本号 + 产物 CSS 中 `860px` 出现次数（基线 1 / 修复 0）双重自证 |
| 浏览器 | Playwright 内置 Chromium（本机 `node_modules`，`reducedMotion: reduce`） |
| 视口矩阵 | wide=1920×1080、wide2400=2400×1200、narrow-1279=1279×900、narrow-1024=1024×800、edit=1920×1080 |
| 主题 | `localStorage["ciki-theme"]` 注入 zustand persist 格式 `{state:{theme,style},version:0}`；paper-light=`{theme:"light",style:"paper"}`、paper-dark=`{theme:"dark",style:"paper"}`、nova-light=`{theme:"light",style:"nova"}`；每次量测记录 `bodyBg` + `data-theme`/`data-mode` 自证主题生效 |
| 账号/数据 | `qa200@example.com`；页面 `/p/1`（验收长文：9 个 H2 + 长段落 + 混排中英文，满足 TOC ≥2 标题渲染条件） |
| 页脚构建号 | `v1.0.0-<提交数>-<短hash>` 来自构建时生成的 `build-info.json`（git 提交数，非构建次数）；两分支页脚文字必然不同，属构建元数据，像素 diff 中单独排除说明 |

## 2. 验收口径与方法

1. **宽视口（≥1920）**：paper 与 Nova 的正文列宽逐值一致；页内导航（TOC aside）贴画布（`[data-page-canvas]`）右缘；导航右侧无大片空白。
2. **窄视口（<1280，aside 整轨隐藏）**：纸面与现状一致、正文吃满。注：任务口径原文「与现状一致」与 #198 定版口径「取消封顶无例外」在 1279px 处存在子句冲突（基线此处 `max-width:860px` 生效，修复后 flex 容器自然撑满 1000px）——按 #198 定版口径解释为「除版式宽度外一切与现状一致」，判定通过并如实记录冲突。
3. **颜色/字体/纹理**：与现状一致，只动版式宽度（列宽 + maxWidth 声明）。
4. **量测**：canvas/container/aside/nav `getBoundingClientRect` + computed `maxWidth` + content 计算样式 + `bodyBg`。
5. **像素 diff**：`pixdiff.mjs`（逐像素，阈值 >8/通道）+ `diffbox.mjs`（32px 网格聚类定位差异区域）。
6. **编辑态**：加载后点击正文首段，把工具条段落样式标签固定为「正文」（消除初始化抖动，见 §5.1），再截图对比。

## 3. 逐项签收表

| # | 验收项 | 标准 | 测法 | 结果 | 证据 |
|---|---|---|---|---|---|
| ① | 宽视口 paper 与 Nova 列宽一致、导航贴右缘、无空白 | 三主题 container/aside 逐值一致 | rect 量测 | **通过**：fix 三主题 container `370.4→1640`（宽 1269.6，maxWidth `none`）、aside `1672→1896` 贴 canvas 右缘 1896；base paper 复现缺陷：container 封顶 860、aside 右缘 1486.4、右侧空白 409.6px | `fix/wide__*`、`base/wide__paper-light-*`、`{base,fix}/measurements.json` |
| ①+ | 2400 超宽复验（「越宽越明显」） | 同上，缺陷随宽度放大 | rect 量测 | **通过**：fix paper/nova 16 字段逐值相同（container `610.5→1954.5` 宽 1344、aside `1986.5→2210.5` 贴 canvas 右缘 2210.5）；base paper container 封顶 860、TOC 右侧空白 **484px**（2210.5−1726.5） | `*/wide2400__*-measurements.json`、`*/wide2400__paper-light-viewport.png` |
| ② | 窄视口 1024 与现状一致 | 逐像素一致 | pixdiff | **通过**：paper diff 411px（0.050%）、nova 454px（0.055%），差异全部为页脚构建号区（行 877–886 / 777–786） | `results/pixdiff-narrow-1024-*.txt` |
| ②+ | 窄视口 1279 | 见 §2.2 冲突说明 | pixdiff | **通过（含记录的口径冲突）**：paper diff 139236px（12.096%）= 正文重排 860→1000，即修复契约本身要达成的变化；nova 578px（0.050%）仅页脚 | `results/pixdiff-narrow-1279-*.txt` |
| ③ | 颜色/字体/纹理与现状一致 | 只动版式宽度 | content 计算样式 + 纹理 opacity + bodyBg | **通过**：两分支 content `fontSize 15px / lineHeight 25.5px / "Inter Variable",…` / `color rgb(42,43,47)`、paperTexture opacity 0.55/0.22、bodyBg `rgb(247,244,238)` 逐值一致；唯一差异 = 列宽 + maxWidth `860px→none` | `{base,fix}/measurements.json` content/paperTexture/bodyBg 字段 |
| ④ | Nova 主题零变化 | 与现状逐像素一致（排除页脚） | pixdiff + diffbox | **通过**：wide 578px（0.028%）、1279 578px（0.050%）、1024 454px（0.055%）、2400 仅页脚（行 1177–1186），差异区全部为页脚构建号 | `results/pixdiff-*-nova-light.txt` |
| ⑤ | 编辑态不受影响 | 几何与像素均与现状一致（#198 约束） | rect 量测 + pixdiff + diffbox | **通过**：paper 主题下 editor `395.4→1871`（宽 1475.6）、surface/title `370.4→1896`（宽 1525.6）两分支逐值相同、工具条标签一致（正文）；像素 diff 587px（0.028%）全部为页脚构建号区（y1056–1087，diffbox 单一聚类） | `*/edit1920__paper-light-*`、`results/pixdiff-edit1920-*.txt`、`results/diffbox-edit1920-*.txt` |
| ⑥ | 守卫测试与构建 | 单测通过、构建绿 | 本地复跑 | **通过**：fix 分支 `npx vitest run src/stores/theme.test.ts` 8/8 通过；两分支 `pnpm build:web`（含 `tsc --noEmit`）均绿 | 构建日志（本次验收会话） |
| ⑦ | 宽视口 paper-dark | 同 ①（暗色） | rect 量测 + pixdiff | **通过**：dark 量测与 light 同值（见 measurements.json `wide__paper-dark`）；pixdiff 15.740% 与 light 15.486% 同为修复重排特征 | `results/pixdiff-wide-paper-dark.txt` |

## 4. 基线缺陷复现表

| 场景 | 基线 563f7c0 | 修复版 6c4a7e7 | 判定 |
|---|---|---|---|
| 1920 paper 列宽 | 封顶 860（maxWidth 860px） | 1269.6（maxWidth none），与 Nova 同值 | **消失** |
| 1920 paper TOC 右侧空白 | 409.6px | 0（aside 贴 canvas 右缘） | **消失** |
| 2400 paper 列宽 | 封顶 860 | 1344，与 Nova 同值 | **消失** |
| 2400 paper TOC 右侧空白 | 484px | 0 | **消失** |
| paper-dark 1920 | 同 paper-light（同一段 CSS） | 同 fix light | **消失** |
| Nova 全视口 | — | 与基线逐像素一致（仅页脚元数据） | 无回归 |
| 编辑态 paper 1920 | — | 与基线逐值/逐像素一致（仅页脚元数据） | 无回归 |
| 1024 窄视口 | 封顶未生效（容器 732 < 860） | 一致（diff 仅页脚） | 无变化 |
| 1279 窄视口 | 封顶生效 860 | 1000（修复契约） | **按契约改变** |

## 5. 观察项（非阻塞，不在本单修复范围）

### 5.1 编辑工具条标签初始化抖动
编辑页加载后未发生点击时，工具条段落样式下拉标签在「正文 / 标题 2」间随机出现（`ParagraphStyleMenu` 由 `useEditorState` 按 selection 实时计算；TipTap 编辑器实例初始化时序内 selection 未定时取值不定）。vite dev（非压缩）模式下同一基线 dist 三次采样结果为「正文 / 标题 2 / 正文」，证实与分支无关、与构建方式无关。本验收重拍时以「点击正文首段」固定标签为「正文」消除该变量。建议另行开单跟进。

### 5.2 主题存储健壮性：非法 theme 值导致应用崩溃（已开后续单）
调查 5.1 期间意外发现：`ciki-theme` 若被写入字段互换的非法值（如 `{theme:"paper",style:"light"}`，theme 期望 `auto|light|dark`、style 期望 `nova|paper`）：
- `index.html` 内联脚本有完整校验（非法值回退 auto/nova），首屏不闪不崩；
- 但 zustand persist 的 `onRehydrateStorage` 只校验 style 不校验 theme，非法 theme 原样进入 store，`ThemeCycleButton` 的 `ICONS[theme]` 查表得 `undefined`，渲染 `<Icon />` 抛 React #130，整个应用落入 "Unexpected Application Error" 错误页（编辑页与读页均复现，12/12）。

真实风险路径：旧版本/手工改动/其他写入方留下的畸形 localStorage。修复建议：rehydrate 校验 theme（与 style 同样处理）。已开后续单，本单不修。

### 5.3 证据完整性说明（重拍记录）
首轮补充脚本（2400 + 编辑态）的主题注入参数字段写反（`theme`/`style` 互换），产出的 4 张截图经 PNG 背景像素采样证实实际渲染 Nova 默认主题（页底 `#fafafa` 而非 paper 的 `rgb(247,244,238)`），判为无效证据整组废弃重拍（`scripts/shoot-extra2.mjs`，函数式 `addInitScript` 传参 + bodyBg/htmlAttrs 自证）。主证据链（7 组宽/窄视口，`scripts/shoot.mjs`）首轮注入即正确，未受影响。该过程同时暴露了 §5.2 的健壮性问题。

## 6. 环境与清理

- worker 服务 `ciki-qa200-worker-9210` 于验收完成后停止；D1 持久化目录 `/tmp/ciki-qa200/state`，属临时造数（`qa200@example.com` + 页面 `/p/1`），不入真实数据，机器清理即消。
- 会话 cookie（`storage-state.json`/`cookies.txt`）与写令牌仅存 `/tmp/qa-200/`，**不入库**。

## 7. 证据清单

```
qa/evidence-qa200/
├── base/  fix/                  # 每分支：7 组视口×主题截图（viewport+full）+ wide2400/edit 截图
│                                #        + measurements.json（主量测）+ wide2400/edit 量测 JSON
├── results/                     # pixdiff-<视口>-<主题>.txt ×9、diffbox-edit1920.txt
└── scripts/                     # shoot.mjs（主矩阵）、shoot-extra2.mjs（2400+编辑态重拍）、
                                 # create-page.mjs（造数）、pixdiff/diffbox/diffpix/crop/scale2x/brighten.mjs（诊断）、
                                 # editlabel.mjs（标签抖动采样）
```
