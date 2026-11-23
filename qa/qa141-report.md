# QA 验收报告（签收表）：#141 运行时真跑——阅读页目录锚点跳转顶出外壳修复（#139）

- **被测对象**：#139 修复提交 `42af32c`（分支基点 `f55419f`），改动 6 文件（`web/src/lib/scroll-anchor.ts`/`.test.ts`、`web/src/components/page/ArticleToc.tsx`/`.test.tsx`、`web/src/pages/PageView.tsx`/`.test.tsx`）
- **对照基线**：`f55419f`（修复前），bug 复现留证后同步骤验收修复版
- **验收方式**：Playwright（Chromium 159.0.8154.6，headless）真实页面真跑，桌面 1440×900 + 移动 390×844（isMobile+hasTouch）双视口；本地 wrangler dev 双实例（:8894=基线 build238、:8895=修复 build239，截图页脚可见构建标识）；管理员会话 storageState 注入；**非代码推断，未改任何被测代码**
- **种子数据**：两实例各建长文 `/p/1`（10 个顶层 h2=heading-1..10，章距 ≈324px，第三章含 `[跳转至第八章](#heading-8)` 正文内锚点）与短文 `/p/2`（单标题两段，不足一屏）
- **判定线口径**：目标标题 `getBoundingClientRect().top` ≈ 正文滚动容器 top + `ACTIVE_LINE=24`；高亮口径：判定线上方最近标题（无则默认首项，与 `ArticleToc` measure 一致）
- **总判定**：**修复版 13/13 项通过（两轮独立跑均 13/13），基线 4/4 复现 bug，建议签收**；3 份 console 监听均为 0 错误

## 一、基线复现（f55419f，:8894）——bug 确认，4/4

| # | 场景 | 结果 | 关键量测 | 证据 |
|---|------|------|---------|------|
| R1 | 点靠下目录条目（第十章 结论） | **复现** | 外壳 flexCol.scrollTop **0→380**、顶栏 rectTop=**-380**（搜索框整条移出视口）、底部 **380px 白色空白**（contentBottom=520/900）、URL 被写 `#heading-10` | base/02-repro-after-bottom-entry.png |
| R2 | 跳转后点「回到顶部」 | **复现** | 先滚轮上滚 400px 使回顶按钮出现（贴近底部时按钮让位隐藏）→ 点击：内容容器 scrollTop→0 但 **flexCol 仍 380、headerTop 仍 -380**——外壳位移残留，「回不到真顶部」 | base/03-repro-after-back-to-top.png |
| R3 | 带锚点直达 `/p/1#heading-6` | **复现** | flexCol=**48**（恰一个 header 高度）、headerTop=-48、底部空白 48px（852/900） | base/04-repro-hash-direct.png |
| R4 | 正文内锚点链接 `#heading-8` | **复现** | 渲染为 `target="_blank"`；点击开新标签页，popup 走 hash 恢复路径，外壳同样位移 48px（flexCol=48、headerTop=-48） | base/05、base/06、base/repro-popup.json |

> 机制注记（与 #140 评审一致）：目标章靠底时正文容器滚到封顶仍到不了判定线，原生锚点导航把差额连带滚进外层外壳（R1 偷走 380px）；`html`/`body` scrollTop 恒 0。R2 证明回顶只滚内容容器、外壳位移不回收。

## 二、修复验收（42af32c，:8895）——13/13 通过，两轮一致

| # | 判定标准 | 测法 | 结果 | 关键证据 |
|---|---------|------|------|---------|
| T1 | 靠下条目（最后一章）：顶栏与搜索框在原位、外壳零位移、底部无白色空白、URL 不写 hash、正文滚动到位且目标完整可见 | 真点目录末条「第十章 结论」，量 html/flexCol scrollTop、header/搜索框 rect、contentBottom/innerH、URL | **通过** | headerTop=0、searchTop=7.5、flexCol=0、html=0、contentBottom=900/900、URL 无 hash、contentScrollTop=2746=max、目标 top=404.28 完整可见；判定线 Δ=+332px（观察 A，几何封顶） | 
| T2 | 靠上条目：自页面下部点击后目标到判定线（±2px）、外壳零位移、顶栏/搜索框在位、底部无空白 | 从第八章位置点「第二章 研究背景」 | **通过** | 判定线 Δ=**-0.47px**、headerTop=0、flexCol=0、contentBottom=900/900 |
| T2b | 靠下且可到线条目：目标到判定线（±2px）、外壳零位移、回顶按钮可见 | 点「第八章 讨论与反思」（距底>96px） | **通过** | Δ=**+0.03px**、backToTop=true、flexCol=0、headerTop=0 |
| T3 | 跳转后点「回到顶部」：正文容器回 0（真顶部）、顶栏/搜索框回原位、外壳零位移 | 第八章位置点回顶按钮 | **通过** | contentScrollTop=0、headerTop=0、flexCol=0、active=heading-1 |
| T4 | 滚动时目录高亮跟随判定线：aria-current 恒等于判定线上方最近标题（无在上方时默认首项） | 顶部/滚轮 1200px/再 1200px/点目录首条回顶，四位置对比应用自身口径 | **通过** | 四位置全对：#heading-1 / #heading-4(1200) / #heading-7(2400) / #heading-1(192) |
| T5 | 带锚点直达 `/p/1#heading-6`：外壳零位移、顶栏/搜索框在位、底部无空白、目标到判定线（±4px，见观察 B） | 新上下文冷打开带 hash URL | **通过** | 两轮 Δ=-0.22px / -3.22px（均在容差内）、headerTop=0、flexCol=0、html=0、contentBottom=900/900 |
| T6 | 短文（无目录）回归：索引轨不渲染、无回顶按钮、顶栏在位、外壳零位移、无 console 错误 | 打开 /p/2 量测 + console 监听 | **通过** | tocPresent=false、backToTop=false、headerTop=0、console 0 错误 |
| T7a | 移动视口（390×844）初始态：外壳零位移、无 TOC（<1280px）、无横向溢出 | 移动模拟打开长文 | **通过** | html.scrollTop=0、docScrollWidth=390、tocPresent=false、header 0–48px 在位 |
| T7b | 移动滚动后外壳稳定：顶栏在原位、html/flexCol 零滚动、回顶按钮出现 | JS 滚动内容 900px 后量测 | **通过** | headerTop=0、flexCol=0、contentScrollTop=900、backToTop=true |
| T7c | 移动 hash 直达：外壳零位移、顶栏在位、目标到判定线（±4px） | 新移动页冷打开 `/p/1#heading-6` | **通过** | 两轮 Δ=+0.03px / -2.97px（容差内）、headerTop=0、flexCol=0 |
| T7d | 移动回到顶部：内容容器回 0、外壳无位移 | 滚动后点回顶按钮 | **通过** | contentScrollTop=0、flexCol=0、headerTop=0 |

## 三、追加排查 T5b：正文内同页锚点链接（#140 非阻断观察，非阻断签收）

**实测结论**：真实页面正文内会出现 `<a href="#heading-8">`（markdown `[x](#heading-8)` 经消毒白名单放行、tiptap 渲染，实测 outerHTML=`<a target="_blank" rel="noopener noreferrer nofollow" href="#heading-8">跳转至第八章（正文内同页锚点链接）</a>`）。

1. **点击行为 = 开新标签页**（target=_blank，Playwright popup 事件确认），**不是**当前页原生 fragment 导航；当前页 URL 与外壳均不变。
2. **当前页外壳零位移**：点击前后 flexCol.scrollTop 均为 24（点击前页面自身状态）、headerTop 恒 -24，无额外位移。
3. **新标签页**落点 `/p/1#heading-8` 走 PageView hash 恢复路径（即本次修复的 `scrollToHeading` 路径）→ **外壳零位移**（popupFlexCol=0、popupHeaderTop=0、contentBottom=844/844），heading-8 判定线 Δ=-1.97px（±4 内）。
4. 结论：正文内锚点链接点击**不会**把外壳顶出（修复后；基线同场景外壳位移 48px，见 R4）。#140 该非阻断观察可关闭，无需追加改动。

## 四、非阻断观察项（不阻断签收，供 follow-up）

- **观察 A · 末尾章节到不了判定线（几何极限）**：第十章需 scrollTop 3078、第九章需 2754.7，均超过内容最大滚动 2746（正文底部余量不足）。修复版滚到封顶、外壳完整，标题停在视口中部（404px）完整可见；基线「对齐」恰是把差额偷进外壳 380px——即 bug 本身。若产品要求末章精确落线，需滚动封顶补偿（如底部 spacer），属新需求。另：封顶处目录高亮按判定线语义停在第八章（第九/十章在判定线下方），属应用既有语义非本次改动引入（fix/02 截图可见）。
- **观察 B · hash 直达 2-3px 晚到布局漂移**：正文挂载后尾部有 -26px 布局收缩（评论空态挂载，位于 heading-6 下方）；若收缩发生在滚动落位之后，目标上方元素被拉高 0.5-3px，终态偏差 -1.2~-3.2px（跨轮次稳定，移动端恒 -2.97）。对齐机制本身精确（目录点击路径 ±0.5px，T2/T2b）。可后续在正文稳定后二次校准，属精度打磨非外壳位移缺陷。
- **回顶按钮接近底部让位**：距底 ≤96px 时按钮隐藏（既有设计，避免遮挡页尾评论「发表」）；点最末条目后需先上滚才见按钮。基线复现 R2 已按真实用户路径（滚轮上滚→点回顶）处理。

## 五、环境与证据

- 实例：`ciki-qa141-base-8894`（f55419f → `v1.0.0-238-f55419f`，:8894）、`ciki-qa141-fix-8895`（42af32c → `v1.0.0-239-42af32c`，:8895），wrangler dev；构建标识烙于截图页脚（base 图=`f55419f+build238`，fix 图=`42af32c+build239`）
- 脚本：`qa141-acceptance.mjs`（repro/full 两模式；量测含 html/body/flexCol scrollTop、header/搜索框 rect、判定线偏差、底部命中元素、URL、console 监听；全程未改被测代码）
- 证据（本目录随本报告入库）：
  - `evidence-qa141/base/`：R1–R4 截图 6 张 + results.json + repro-popup.json + repro-body-link.json + console.json
  - `evidence-qa141/fix/`、`evidence-qa141/fix2/`：A0–T7d 截图各 13 张 + results.json + console.json（两轮独立跑）
  - `evidence-qa141/base-run.log`、`fix-run.log`、`fix-run2.log`：三轮完整运行日志
- 登录：管理员会话 storageState 注入（state-8894/8895.json）；零 console 错误（三份 console.json 均空）
