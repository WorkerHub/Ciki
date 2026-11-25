# QA #213 — 文档目录拖动排序去回弹 + 取消拖动改层级·验收报告（Jim 真跑）

- **验收对象**：todo #213；实现单 #212（PR #277，commit `e41b65a` = main HEAD）
- **执行**：2026-11-25，Playwright 真实浏览器操作（Chrome for Testing，chromium-1255），真实指针手势（hover 把手 → 按下 → 位移 ≥4px 激活 PointerSensor → 移动 → 松手），非 JS 注入
- **结论**：**通过 — 7/7 项全绿；30/30 断言，第三轮完整运行一次通过，零放水**

---

## 0. 版本门 ✅

| 核对项 | 值 | 说明 |
|---|---|---|
| 被测 commit | `e41b65a`（PR #277 已合并 main） | 与生产部署版本同源 |
| 生产 `GET /api/public` | `version: v1.0.0-291-e41b65a` | 验收前置核对（只读） |
| 本地实例 `GET /api/public` | `version: v1.0.0-291-e41b65a` | 本轮实测，与生产一致 |
| 等价口径 | 生产注册关闭（`registrationEnabled:false`，#46 已证实）无可用账号 | 沿用 #205/#48 先例：**不做生产写入**，以同 commit 本地生产等价实例真跑 |

## 1. 测试环境

1. `git fetch` main → checkout `e41b65a`（树干净）→ `/tmp/ciki-qa213/repo`
2. `pnpm build:web`（build-info `v1.0.0-291-e41b65a`）
3. `wrangler dev --port 8846 --var APP_VERSION:… --persist-to /tmp/ciki-qa213/state`（专属持久化目录，避开本机其他任务遗留 wrangler 实例的共享 `.wrangler/state` 污染）
4. `POST /api/setup` → 6/6 迁移 applied；注册首个用户即管理员（`qa213@local.test`）
5. 测试树（默认空间 id=1）：`1 QA 拖拽-甲`、`2 QA 拖拽-乙`（子页 `4 QA 子页-一`、`5 QA 子页-二`）、`3 QA 拖拽-丙`
6. Playwright 1.65.1；每项独立 browser context（独立录屏 10 段 webm）+ UI 登录 storageState；树序采样器每 130–200ms 读一次真实 DOM（`li[data-tree-row]` 序列）；预览线采样器每 60ms 读 `[data-drop-preview]` 的 `left`
7. 网络控制：Slow 3G 用 CDP `Network.emulateNetworkConditions`（latency 400ms、上下行 ≈400kbps）；接口失败用 `page.route` 延迟 800ms 后 abort（可观测乐观中间态）；断网用 CDP `offline:true` 全真断网
8. 每轮运行前将服务端树经 move API 复位到基准，保证各项从已知状态出发

## 2. 逐项签收表

| # | 验收标准 | 测法 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 正常网络：拖一页到新位置，松手即新顺序，全程无回弹 | `[3,1,2]`→ 拖 P3(丙) 到 P1(甲) 上 → 松手后**立即**读树 = `3,1,2`（877ms 手势内）；随后 3.2s 采样 25 次恒为 `3,1,2`，无一次回跳旧序；收敛后再读仍 `3,1,2` | **PASS** | `shots/T1-final-312.png`；`video/T1*.webm`；`qa213-results.json` T1a/b/c（含完整时间线） |
| 2 | Slow 3G 节流：新顺序立即保持，同步完成后不变、不跳动 | CDP Slow 3G（400ms RTT/400kbps）下 `[3,1,2]`→ 拖 P1 到 P2 之后 → 松手立即 = `3,2,1`；**12s 同步窗口采样 59 次唯一值 = `["3,2,1"]`**（move+repair+tree 多请求期间零跳动）；解除节流刷新后服务端 = `3,2,1` | **PASS** | `shots/T2-final-321.png`；`video/T2*.webm`；results T2a/b/c |
| 3 | 断网/接口失败：松手短暂新顺序 → 回滚原序 + 错误提示；恢复刷新后为原序 | **3a（route abort 800ms）**：拖 P1 到 P3 上半部 → 乐观呈现 `1,3,2`（失败在途期间稳定保持）→ 回滚精确到 `3,2,1` + `role=alert`「网络异常，请稍后重试」→ 恢复后刷新 = `3,2,1`。**3b（CDP 全真断网）**：同样拖动 → 回滚 `3,2,1` + alert；恢复网络刷新 = `3,2,1` | **PASS** | `shots/T3-rollback-alert.png`、`shots/T3x-offline-alert.png`；`video/T3*`、`video/T3x*`；results T3a–d、T3x a–c |
| 4 | 连续两次快速拖放：最终顺序正确，刷新后保持（服务端已落） | 每笔 move 延迟 400ms（保证第二笔在第一笔未同步时发起）：`[3,2,1]`→① 拖 P3 到 P2 之后（松手即 `2,3,1`）→② **立即**拖 P2 到 P1 之后 → 终态 `3,1,2`，5s 采样恒定；刷新后服务端 = `3,1,2` | **PASS** | `shots/T4-final-312.png`；`video/T4*.webm`；results T4a/b/c |
| 5 | 拖动改层级已取消：横向移动不改落点层级，预览线深度恒定；子页拖到其他层级行松手不改父级 | **跨级**：拖子页 C1(4) 到顶层行 P1 上并横向大幅晃动（±90px）→ 全程 39 次采样**无一帧预览线**（不同父级不产生落点）、**0 条 move 请求**、松手后 C1 仍 depth=1。**子页同级对照**：拖 C1 到 C2 上并晃动 → 出现过的预览线 18/18 恒 `left=20px`（depth1×18+2，横向晃动不变）→ 松手落同级 `[5,4]` 且都 depth=1。**顶层对照**：同级拖动预览线 19/19 恒 `left=2px` | **PASS** | `shots/T5-after-no-reparent.png`、`shots/T5d-subpage-sibling-drop.png`；`video/T5*`；results T5a/b/c、T5d a/b、T5x a/b |
| 6 | 行菜单「移动」对话框同空间改父级回归（含移到顶层），刷新后保持 | P3(丙) 行菜单「移动…」→ 对话框父级选「QA 拖拽-甲」→ 提交后树 `2,1,3` 且 P3 depth=1；**刷新后保持**。第二段：P3 移回顶层（选项「顶层（无父页面）」）→ depth=0；**刷新后保持** | **PASS** | `shots/T6-dialog-open.png`、`shots/T6-moved-under-p1.png`、`shots/T6-moved-to-top.png`；`video/T6*.webm`；results T6a–d |
| 7 | Nova/纸面两主题各验一次主路径 | Nova（`html[data-theme="nova"]`）：`[2,1,3]`→ 拖 P1 到 P3 之后 → `2,3,1` 且 2.5s 采样恒定。纸面（`html[data-theme="paper"]`）：`[2,3,1]`→ 拖 P3 到 P2 之前 → `3,2,1` 且恒定 | **PASS** | `shots/T7-nova-drag-done.png`、`shots/T7-paper-drag-done.png`；`video/T7*.webm`；results T7-nova/T7-paper |

补充说明：验收第 3 项的「乐观呈现」由 3a（延迟失败）证实；3b 真断网下 fetch 立即被拒，乐观态毫秒级即被精确回滚，130ms 级采样捕获不到瞬时中间态属预期（失败越快回滚越快），实测值已如实记录在 results T3x-a。

## 3. 服务端落库核对

- 每一项拖动/移动后均经「刷新页面重读树」核对服务端落库（T1c/T2c/T3d/T3x-c/T4c/T6b/T6d），无一例 UI 与服务端不一致。
- 全部验收完成后的服务端终态（`GET /api/pages?spaceId=1`）：顶层 `3 QA 拖拽-丙`、`2 QA 拖拽-乙`（子 `5 QA 子页-二`、`4 QA 子页-一`）、`1 QA 拖拽-甲` —— 与 T7 纸面段最后一笔拖动完全一致。

## 4. 边界与说明（不放水声明）

- **应用缺陷：无。** 三轮运行中全部 FAIL/FATAL 均为**测试代码问题**，逐条列明：① 首轮 T3 卡死——`/` 路由链式重定向到第一页详情未稳定即动手，鼠标落空（补 waitForURL 后修复）；② 次轮 T3a——期望值算反（「拖到目标行上偏下」按落点契约为插入目标行之后，应用行为本就正确）；③ 次轮 T3x-a——真断网乐观态毫秒级回滚无法采样（断言语义修正并如实记录）；④ 次轮 T5b——断言设计反了，跨级拖动全程无预览线正是契约行为；⑤ 次轮 T5d-a——采样含拖动激活前阶段，null 属正常，断言修正为只判出现过的预览线；⑥ 次轮 T7——主题已是 Nova 无变更时 appearance 保存按钮为 disabled，定位失败（改为当前已符合期望主题则跳过设置）。第三轮 30/30 一次通过，无重试到通过的情况。
- **乐观呈现的证据链**：接口失败路径（T3a）实测到乐观态稳定保持 800ms 后精确回滚；真断网路径（T3x）实测回滚 + 错误提示 + 刷新后原序。
- **生产侧只读**：仅 `GET /api/public` 与版本核对，无任何生产写入。
- **范围外发现（未改，不属本单）**：`README.md` 第 38 行仍写「拖拽调整层级与顺序」，与本单已定版的「拖动只保留同级排序、改层级走移动对话框」不符，文档滞后。

## 5. 清理

- 本地实例（服务 `ciki-qa213-worker`，端口 8846）已停止。
- `/tmp/ciki-qa213`（repo、wrangler state、cookies）已整体删除；证据全部保留于本单分支 `qa/qa213-evidence/`。

## 6. 复现路径

```bash
# 1) 同 commit 本地实例（secret 临时生成，不入库）
git fetch origin main && git checkout e41b65a
pnpm install --frozen-lockfile && pnpm build:web
printf 'ENCRYPTION_KEY=%s\nSETUP_SECRET=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 24)" > worker/.dev.vars
cd worker && pnpm exec wrangler dev --port 8846 --ip 127.0.0.1 \
  --var APP_VERSION:v1.0.0-291-e41b65a --persist-to /tmp/qa213/state

# 2) 初始化 + 基准树（首个用户=管理员）
curl -s -X POST http://127.0.0.1:8846/api/setup -H "X-Setup-Secret: $SS" -H 'Content-Type: application/json' -d '{"title":"QA213"}'
# 注册 qa213@local.test；用 UI/API 建 1 甲、2 乙(子 4、5)、3 丙

# 3) Playwright 真跑（30 断言，含 CDP 节流/断网、录屏、树序与预览线采样）
node qa/qa213-evidence/scripts/accept.mjs   # BASE 默认 http://127.0.0.1:8846，证据落 /tmp/ciki-qa213-evidence

# 4) 服务端核对
curl -s "http://127.0.0.1:8846/api/pages?spaceId=1"   # 各步后刷新核对 + 终态树
```

断言明细（含每 130ms 一帧的完整树序时间线、预览线逐帧 left 采样、move 请求日志）见 `qa213-results.json` 与 `qa213-log.txt`；录屏 10 段见 `video/`。
