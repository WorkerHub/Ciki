# QA254 生产 QA 报告：回收站跨空间汇总 + 批量清理

- 工单：#254（回收站跨空间汇总与批量清理 · 生产 QA）
- 实现单：#248（后端）、#249（前端）；PR #296（`4a06180`）、PR #297（`fa3d6797`）
- 生产版本：`v1.0.0-310-fa3d679`（`GET /api/public` 实测；Deploy run `45810721159` = success，与线上一致）
- 测试日期：2026-11-26
- 结论：**5/5 条口径全部通过**，断言 **51/51 PASS**（明细见 `qa254-evidence/results.json`）。

## 1. 测试环境与方法

- 全部用例跑在**真实生产环境** `https://ciki.oneboy.app`，真实生产 D1 / R2，不做代码审查代替实测。
- 浏览器：本机真实 Chromium（Google Chrome for Testing 159，headless），显式本地代理 `http://127.0.0.1:7890`；Playwright `newContext({ proxy })` 同时覆盖页面与 APIRequestContext。
- 数据铸造（生产 D1/接口直接铸入，隔离命名 `QA254`）：
  - 2 个 QA 用户：A `qa254a`（甲/乙 admin、丙 viewer）、B `qa254b`（丙 admin）；
  - 3 个 QA 空间：甲 `17`、乙 `18`、丙 `19`（另清理了首跑脚本失败遗留的空空间 `14/15/16`，见 §4）；
  - 12 个页面 P1–P12（P1/P10 为子树根，P6/P7 在只读空间丙，P8 用于版本历史，P5 单条彻删，P9 跨空间批量彻删，P12 清空全部用）+ 负例复测补铸 P13；
  - 15 个版本行、16 个内容对象（`ciki-content`，key=`content/<sha256>`）。
- 凭证纪律：会话 Cookie 与写令牌仅存 `/tmp/qa254/tokens.env`（权限 0600），不进仓库/证据/报告；归档前对全部 128 个工件做了令牌全文扫描，零泄露。终核后所有会话/令牌已在 D1 撤销并验证 401。
- 证据目录：`qa/qa254-evidence/`（results.json = 51 条断言逐条记录；log/ = 铸数、P8 修复、负例、拆除全程日志；shots/ = 21 张过程截图；scripts/ = 脱敏工装）。

## 2. 逐项签收表

| # | 标准 | 测法 | 结果 | 证据 |
|---|------|------|------|------|
| 1 | 默认汇总全部空间；空间列、创建/删除时间、空间筛选正确 | 真实 Chromium 以 A 登录 `/s/space-17/trash`：默认 9 个根条目（子页隐藏）；行序=删除时间倒序 P9→P10→P12→P8→P7→P6→P5→P4→P1；9/9 行空间列与 D1 一致；9/9 创建/删除时间渲染；页头「汇总全部空间。」；筛乙=3 行、丙=2 行、甲=4 行、切回全部=9 行 | **PASS**（10 断言：1a–1i、1e） | `shots/00,01,02,03`；`results.json#1a-rows…1e-summary` |
| 2 | 子页面数与彻底删除弹窗计数正确 | P1 行显示子页面数 2、P10 行 1、其余不显示（P2/P3/P11 隐藏、由 childCount 表达）；弹窗实测：P1「共 1 项条目，含子页面共 3 篇」；P4+P9「共 2 项条目，含子页面共 2 篇」；P10「共 1 项条目，含子页面共 2 篇」 | **PASS**（4 断言：2a–2d） | `shots/04,05,06`；`results.json#2a-childcount…2d-dialog-p10` |
| 3 | 批量恢复/批量彻删/清空全部空间/清空单空间生效，正确处理子树与版本历史 | ① 批量恢复 P4+P10：行消失，D1 三页（含 P11 随父）deleted_at 全部清空，版本行保留；② 单条恢复 P8：deleted_at=NULL，v1–v4 四个版本全在，正文=v3b；③ 批量彻删 P1+P9（跨空间）：D1 pages/revisions/FTS 0/0/0 ×4 id；④ A 清空全部空间：弹窗只计可编辑条目（1 项 1 篇，只读 P6/P7 不计），执行后剩 2 只读行，无可编辑条目时清空按钮禁用；⑤ B 清空丙：2 行→弹窗 2 项 2 篇→toast「成功 2 项」→D1 P6/P7 0/0/0 | **PASS**（17 断言：3a*、3b*、3c*、3d*、5a-d1*） | `shots/08–15,17–19`；`results.json#3a-*…3d-b-d1`；`log/teardown.txt` |
| 4 | 无编辑权空间的条目只读 | UI：P6/P7 行无勾选框、无恢复/彻删按钮；只读空间视图提示「你是只读成员，只能查看。」、清空/全选禁用；接口负例（补铸 P13 复测）：A 批量恢复/批量彻删 → HTTP 200 + 逐项 `ok:false FORBIDDEN` 且 D1 未变；A `DELETE /api/pages/:id/permanent` → **403 Forbidden** 且 D1 未变 | **PASS**（8 断言：4a、4b、4c×5、4c-ui-still） | `shots/07,16`；`results.json#4a-…4c-*`；`log/negatives-fixed.txt` |
| 5 | 单条恢复/彻底删除行为与改动前一致 | 单条恢复无确认弹窗、即时生效（行消失、D1 确认）；单条彻删有 AlertDialog（标题含页面名，「共 1 项条目，含子页面共 1 篇」）；恢复不存在的页面 → 404 | **PASS**（6 断言：5a*、5b*、4c-api-404） | `shots/10,11`；`results.json#5a-…5b-d1` |

## 3. 行为语义记录（实测确认，供团队备案）

- 回收站列表只显示同批软删的**子树根**，子页隐藏并以 `childCount` 表达；排序 `deleted_at DESC, sort_order`。
- 批量恢复**不弹确认框**（按设计）；批量彻删与清空均有 `AlertDialog` 且计数只含可编辑条目。
- 批量接口对无权条目返回 HTTP 200 + 逐项 `ok:false`（部分成功语义）；单条 permanent 对无权条目返回 403（拒绝但存在性可见于有权限判定的角色）。
- 只读行级控制：无勾选框、无单条按钮、不进清空计数、批量接口逐项拒绝。

## 4. 过程异常与修正（如实记录）

1. **cast.sh 首跑失败遗留空空间 14/15/16**（与正式空间同名）：UI 筛选项出现重名歧义；在 UI 跑批前按 id 精确删除（14/15 by A、16 by B），不把测试工件误报为产品问题。
2. **pgedit 参数序错误**导致 P8 正文一度为 `"426"`：通过恢复→两轮编辑→重新软删修复；P8 终态 4 个版本（v1–v4）、正文 v3b，反而强化了「恢复不丢版本历史」的验证。
3. **UI 跑批分两段完成**：首段 39 项全过后，在接口负例步因 APIRequestContext 未继承浏览器代理被 RST 中断；修复为 `newContext({ proxy })` 后以续跑脚本完成后 12 项。中断点在破坏性步骤之前/之后均有 D1 核对，未盲目重跑。
4. **4c-api-permanent 首测误用 POST** 得 404（方法不存在，假阳性）：补铸 P13 后以正确方法 **DELETE** 重测，得 403 Forbidden（真权限拒绝），并同步修正 `results.json` 对应条目（条目内保留 note）。
5. **Playwright 错误日志曾把会话 Cookie 打入控制台**并短暂进入 results.json 的 FATAL 堆栈：FATAL 条目已剥离；归档前对全部工件做 4 种凭证特征串全文扫描，零残留。
6. **P13 内容对象无 D1 记录可查**：按 `content-store.ts` 序列化口径（对象入参 → `JSON.stringify` 紧凑串、键序=解析序）确定性重算 sha256，并从 R2 取回对象 gunzip 逐字验证后才纳入清理集。

## 5. 清理与终核

拆除明细（`log/teardown.txt`，每步 D1 验证，不符即中止）：

- 活动页 P4/P8/P10/P11：写令牌软删（P10 子树带 P11）→ 会话永久删除 → pages/revisions/FTS 0/0/0；
- R2 `ciki-content`：16 个 QA 内容对象逐一删除，删除后逐一 GET 验证 404（`definitive-hashes.txt` = 铸后快照 ∪ P13，与 content-keys.txt 对账一致）；
- 空间 17/18/19 及成员关系删除（spaces=0、members=0）；
- 用户 18316/18317 及其 sessions/api_tokens/space_members 全部删除；撤销后会话调 `/api/me` → **401**；
- 顺带清理：本次 QA 产生的写限流计数器 2 行（`write:18316:`、`write:18317:`）；**前役遗留**孤儿 FTS 2 行（page 410=QA232、416=QA244，铸前即存在，按精确 id + 安全条件删除）。

终核（`baseline.sh verify`）与铸数前基线逐项相等：

| 指标 | 铸前基线 | 终核 |
|------|---------|------|
| users_total | 4 | 4 |
| spaces_total | 8 | 8 |
| pages_active | 380 | 380 |
| pages_trashed | 0 | 0 |
| revisions_total | 815 | 815 |
| sessions_total | 14 | 14 |
| api_tokens_total | 9 | 9 |
| space_members_total | 22 | 22 |
| auth_counters_total | 163 | 163 |
| QA 残留（users/spaces/pages/revisions/fts/members/sessions/tokens） | — | 全 0 |

## 6. 结论

回收站跨空间汇总、筛选与列信息、子树计数与弹窗计数、批量恢复/彻删/清空（含子树与版本历史处理）、只读权限（UI 行级 + 接口层）、单条行为兼容性全部通过生产实测；生产数据与 R2 已恢复铸数前基线，无任何 QA 残留。**QA254 五条口径全部签收通过。**
