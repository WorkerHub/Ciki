# QA #295 验收报告：用户管理页「用户名」列（生产真跑）

- 被测对象：https://ciki.oneboy.app 系统管理 → 用户管理（`/admin/users`）
- 对应变更：PR #295，合并提交 `7fcfde1`（`feat(admin): add username column to users table (#295)`）
- 生产版本：`v1.0.0-308-7fcfde1`（`/api/public` 实测），与 PR #295 合并提交一致
- 验收方式：真实 Chromium 浏览器（playwright-core 1.65.1 + Chromium 159，1440×900，locale zh-CN）走**真实登录表单**进入页面，读**真实渲染结果**，与**生产 D1 直查值**逐行比对
- 结论：**通过（20/20 项断言全绿，无失败项），建议签收**

---

## 一、结论摘要

| 冻结验收标准 | 结果 |
| --- | --- |
| 用户管理页出现「用户名」列，每行 username 与库内一致（普通用户行 + agent 行都验） | ✅ 通过（U1–U4） |
| 其余列不变 | ✅ 通过（C1–C3） |
| Agent 徽标与「（你）」标记仍在第一列 | ✅ 通过（A1、A2、E2） |
| 中英表头正确（中文「用户名」/ English "Username"） | ✅ 通过（H1–H3、E1–E5） |
| 生产版本确认为 PR #295 | ✅ `v1.0.0-308-7fcfde1` |

本轮共 20 项断言，`TOTAL=20 PASS=20 FAIL=0`（明细见 `qa/qa295-evidence/metrics.txt` 与 `results.json`）。

---

## 二、验收前置：生产版本确认

| 项 | 测法 | 结果 | 证据 |
| --- | --- | --- | --- |
| 生产版本 = PR #295 合并提交 | `GET https://ciki.oneboy.app/api/public` | `{"name":"Ciki","version":"v1.0.0-308-7fcfde1"}` ✅ | `qa/qa295-evidence/log/prod-version.txt` |
| 该提交确已并入 main | `git fetch origin main` 后 `git merge-base --is-ancestor 7fcfde1 origin/main` | true ✅（origin/main HEAD 即 `7fcfde1`） | 同上文件说明 |
| 线上前端产物确含本次改动 | 抓 `index.html` 引用的 108 个 asset，逐一 grep | 命中 `assets/UsersTab-BhxeUf8R.js` 内含 `t("admin.users.table.username")`；locale chunk 内含 `table:{email:\`邮箱\`,username:\`用户名\`,...}` ✅ | `qa/qa295-evidence/log/deployed-bundle.txt` |

> 说明：`ciki.pama.workers.dev` 证书名不匹配（SSL 报错），本轮统一用 `ciki.oneboy.app`。
> 第 3 项是**独立于版本号字符串**的第二重取证——线上跑的 bundle 里确实有新增列的代码，而不是只改了版本号。

---

## 三、逐项签收表

### 3.1 表头与列结构

| ID | 冻结标准 | 测法 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| H1 | 中文表头正确且顺序合理 | 真实登录 → `/admin/users` → 读 `table thead th` 全部文本 | ✅ 得到 `[邮箱, 用户名, 角色, 状态, 注册于, 操作]`，与期望完全相等 | `results.json#H1`、截图 `shots/01-admin-users-zh.png` |
| H2 | 「用户名」列紧跟「邮箱」列 | 同上，比对表头下标 | ✅ 「用户名」位于第 2 位（邮箱之后、角色之前） | `results.json#H2` |
| H3 | 表头列数与数据列数匹配 | 读表头格子数 + 逐行 `td` 数 | ✅ 表头 6 列，每行 6 个单元格 | `results.json#H3`、`#C1` |

### 3.2 「用户名」取值与库内一致（普通用户行 + agent 行）

| ID | 冻结标准 | 测法 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| U1 | 每行 username 与库内一致 | 对**每一行**：用该行首列邮箱反查生产 D1 `users` 行，取 `users.username`，与该行「用户名」列文本比对；同时与 `/api/admin/users` 响应体里的 `username` 三方比对 | ✅ 6/6 行全部一致（覆盖 4 个普通用户行 + 2 个 agent 行） | `results.json#U1`（逐行 db/ui/api 三值） |
| U2 | 普通用户行一致 | 拆出 kind=human 的行单独判定 | ✅ 4 行全一致 | `results.json#U2` |
| U3 | agent 行一致 | 拆出 kind=agent 的行单独判定 | ✅ 2 行全一致 | `results.json#U3` |
| U4 | 后端 DTO 下发该字段 | 同会话 `fetch /api/admin/users`，校验每个用户都有 `username` 字符串且与库内相同 | ✅ 6/6 用户均有 `username` 且与库内一致 | `results.json#U4`、`log/api-admin-users.json` |

补充说明：生产存在一条 `users.username` 为**空串**的存量用户（id=18306），线上「用户名」列相应显示为空单元格 —— 与库内一致，属合法状态，**不是缺陷**（详见第七节观察项）。

### 3.3 其余列不变

| ID | 冻结标准 | 测法 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| C1 | 角色/状态/注册于/操作四列仍正常渲染 | 逐行读第 3–6 格：角色文案、状态文案、日期文本、操作列内按钮数 | ✅ 4 列全部正常，每行恰好 6 格 | `results.json#C1` |
| C2 | 其余列取值仍与库内一致（真回归，非只看渲染） | 角色：库内 `role=admin` ⇔ 界面「管理员」，`role=user` ⇔「普通用户」；状态：`is_active=1 且 approval_status=approved` ⇔「正常」；注册于：界面日期与库内 `created_at` 的 UTC 日期相差 ≤1 天（前端按浏览器时区格式化）；操作列至少 1 个按钮 | ✅ 6 行 × 4 列全部吻合 | `results.json#C2` |
| C3 | 新增列未改变排序 | 界面行序与库内 `created_at DESC` 逐 id 比对 | ✅ 完全一致 | `results.json#C3` |

### 3.4 Agent 徽标与「（你）」标记仍在第一列

| ID | 冻结标准 | 测法 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| A1 | Agent 标记仍在第一列 | 两种形态各造一行分别验：**有 owner** → 「（owner 的 Agent）」文字形态；**无 owner**（`owner_user_id=NULL`）→ 独立「Agent」徽标形态 | ✅ 两种形态都出现在第 1 格，未被挤到「用户名」列 | `results.json#A1`、截图 `01-admin-users-zh.png`（第 1、5 行） |
| A2 | 「（你）」标记仍在第一列且只出现在本人行 | 逐行首格搜索「（你）」 | ✅ 仅本人行首格出现「（你）」，其余 5 行无 | `results.json#A2`、截图第 2 行 |

### 3.5 加载态 / 空态

| ID | 冻结标准 | 测法 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| L2 | 加载态单元格 colspan 与新列数匹配 | 用路由拦截把 `/api/admin/users` 延迟 6s，reload 后抓加载态 `td` 的 `colspan` | ✅ `colspan="6"` | `results.json#L2` |
| L3 | 空态单元格 colspan 与新列数匹配 | 切到「待批准」筛选（生产无待批准账号）→ 抓空态 `td` 的 `colspan` 与文案 | ✅ `colspan="6"`，文案「没有待批准的注册申请。」 | `results.json#L3`、截图 `shots/02-admin-users-empty-pending.png` |

### 3.6 英文表头与语言切换

| ID | 冻结标准 | 测法 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| E1 | 英文表头正确 | 在设置页用**真实 UI** 把界面语言切到 English 并保存 → 回到用户管理页读表头 | ✅ `[Email, Username, Role, Status, Registered, Actions]`，"Username" 正确 | `results.json#E1`、截图 `shots/03-admin-users-en.png` |
| E2 | 英文下「（你）」标记变为 (you) 且仍在第一列 | 同上页面逐行首格检查 | ✅ 首格为 `qa295admin@qa.test (you)`，标记仍在第一列 | `results.json#E2`、截图第 2 行 |
| E3 | 中英切换后「用户名」列取值不变 | 同一批用户的英文态取值与中文态取值逐行比对 | ✅ 两份列表完全相同（含那条空串用户） | `results.json#E3` |
| E4 | 语言切换真实生效 | 读 `document.documentElement.lang` | ✅ `en` | `results.json#E4` |
| E5 | 语言切换写回账号（真切换而非仅本地） | 切完查生产 D1 `users.language` | ✅ `en`（账号级语言持久化，验证确实走了真实保存路径） | `results.json#E5` |

---

## 四、测试数据与环境处置

| 项 | 内容 |
| --- | --- |
| 铸造 | 生产 D1 `users` 新增 2 行：uid **18314**（`qa295_admin`，human / admin / 角色=管理员，覆盖「（你）」标记）、uid **18315**（`qa295_agent_orphan`，agent / `owner_user_id=NULL`，覆盖无 owner 的「Agent」徽标分支） |
| 凭据处置 | 口令随机生成，只落 `/tmp/qa295/qa.env`（mode 600）；证据脚本改为从 `QA_EMAIL`/`QA_PASSWORD`/`QA_UID` 环境变量读取；cookies / storage state 未入库 |
| 副作用 | 语言切换验收把 18314 的 `users.language` 写成 `en`（预期副作用）；该行整行随拆除删除，无残留 |
| 拆除 | `DELETE FROM sessions WHERE user_id IN (18314,18315)` → `DELETE FROM users WHERE id IN (18314,18315)` |
| 残留核验 | users / sessions / api_tokens / space_members / pages / page_revisions / comments / notifications / auth_challenges / email_codes / import_tokens / passkey_credentials / user_2fa **全部为 0** |
| 基线核验 | 铸造前基线 4 行（id 1/5/6/18306）拆除后**逐字段 diff = NONE**，无新增行、无缺失行 |
| 登录复核 | 两个已删账号 `POST /api/auth/login` 均返回 **HTTP 401** `{"error":"Invalid credentials"}` |
| 未触碰 | 生产 R2 对象、其他用户数据、既有页面/评论/通知一律未改动 |

---

## 五、证据清单（`qa/qa295-evidence/`）

```
qa/qa295-report.md                    本报告
qa/qa295-evidence/
├── metrics.txt                        20 项断言汇总（ID / 结果 / 验收点）
├── results.json                       每项断言的原始数据（逐行 db/ui/api 三值、断言细节）
├── shots/
│   ├── 01-admin-users-zh.png          中文态用户管理页（含 6 行、Agent 徽标、「（你）」）
│   ├── 02-admin-users-empty-pending.png  「待批准」空态（colspan=6）
│   └── 03-admin-users-en.png          英文态用户管理页（Email/Username/…、(you)）
├── log/
│   ├── prod-version.txt               /api/public 版本 + 响应头 + main 祖先校验结论
│   ├── deployed-bundle.txt            线上 bundle 命中 admin.users.table.username 的取证片段
│   ├── api-admin-users.json           同会话抓取的管理接口原始响应（邮箱已脱敏）
│   └── baseline-and-teardown.txt      铸造前基线、铸造行、拆除后、逐字段 diff、残留计数、401 复核
└── scripts/
    ├── run.mjs                        浏览器真跑脚本（凭据走环境变量）
    ├── mint-admin.mjs                 铸造脚本（口令随机、只落 600 权限文件）
    ├── teardown.sh                    拆除 + 残留 + 401 复核脚本
    └── d1q.sh                         生产 D1 只读查询助手（token 只从本机 wrangler 配置读，不落盘）
```

## 六、复现路径

本轮无失败项，故无失败项复现路径。整体复现方式：

```bash
# 1) 造 QA 管理员（写生产 users 一行）
export QA_ENV=/tmp/qa295/qa.env QA_D1Q=/tmp/qa295/d1q.sh
node qa/qa295-evidence/scripts/mint-admin.mjs && . $QA_ENV

# 2) 浏览器真跑（真实登录表单 → /admin/users → 逐行比对生产 D1）
export QA_OUT=/tmp/qa295/out
node qa/qa295-evidence/scripts/run.mjs        # 产出 results.json + shots/*.png

# 3) 拆除与核验
export QA_AGENT_UID=<agent uid>
bash qa/qa295-evidence/scripts/teardown.sh
```

## 七、观察项（非缺陷，仅告知）

1. 生产存在一条 `users.username` 为空串的存量用户（id=18306，来自更早一轮 QA #234 的残留数据，非本轮产生）。线上「用户名」列对该行显示为空单元格，与库内一致，符合验收标准；本轮**未触碰**该行（不属于本轮铸造数据）。
2. `ciki.pama.workers.dev` 的 TLS 证书与域名不匹配，浏览器与 curl 直连均报错；验收统一走 `ciki.oneboy.app`。

## 八、约束遵守情况

- **只读验证**：本轮未修改任何产品代码，未代实现者修复任何 bug；仅在生产 D1 中增删自己铸造的两行 QA 数据，测后已按基线逐字段核验复原。
- **实测优先**：全部结论来自真实浏览器渲染结果与生产 D1 直查值的比对，未以「代码看着对」代替实测；线上 bundle 取证作为第二重独立佐证。
- **不放水**：加载态、空态、agent 两形态、「（你）」、中英双语、行序与未改动列的取值一致性均逐项实测，无一项因「看起来没问题」而跳过。
- **证据归属**：全部报告与证据仅提交于本工单会话分支（`tds/conv-01a21768-…`），**不进入仓库 main**（main 当前无 `qa/` 目录）。
