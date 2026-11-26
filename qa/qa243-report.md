# QA #243 生产验收报告

- **单号**：Ciki #243（修复 API 令牌无法读取 Embed 文件 + 收敛公开信息字段）
- **被验变更**：main `9035f6e`（PR #294）
- **生产环境**：`https://ciki.oneboy.app`，生产版本 `v1.0.0-307-9035f6e`（与被验 commit 一致）
- **验收日期**：2026-11-26
- **验收方式**：生产真跑——铸造独立 QA 账号与 read/write API 令牌 → write 令牌上传验收物 → 令牌读回逐字节比对 → 契约文档逐字段核对 → 测后精确拆除并以全量快照核验
- **证据目录**：`qa/qa243-evidence/`（本分支内，见 §6）

---

## 0. 结论总表

| # | 验收口径 | 结果 | 备注 |
|---|---------|------|------|
| 1 | write 上传 embed 后，同主人 read/write 令牌 `GET /api/read/files/embeds/<uuid>.html` 返回 200、`Content-Type: text/html; charset=utf-8`、正文逐字节一致 | **功能通过；严格 wire 字节口径 FAIL（环境因素）** | 200 与 Content-Type 均满足；响应正文被 Cloudflare zone 级脚本注入改写（见 §4），剥离注入片段后与源对象逐字节一致；R2 源对象与上传文件逐字节一致 |
| 2 | 他人令牌读同一 key 返回 404 `File not found` | **PASS** | read/write 两种令牌均验证，正文精确为 `{"error":"File not found"}` |
| 3 | 图片 key、画布场景 JSON key 读回行为与改前一致；乱拼 key 仍 404 | **PASS** | 图片/场景 JSON 均字节一致；8 种乱拼/非法 key 全部 404 |
| 4 | `/api/public/agent-guide` 与 `/api/openapi.json` 描述与新行为一致 | **PASS** | 见 §2.4 逐条核对结果 |
| 5 | `/api/public` 不再含 `repositoryUrl`，其余字段逐项一致 | **PASS** | 字段集合恰为 4 项，逐值核对一致 |

主断言共 23 条：**PASS 20 / FAIL 3**。3 条 FAIL（A1、A2、R2OBJ_embed）均为同一根因——Cloudflare 边缘对 `text/html` 响应的注入，与应用代码无关（详见 §4）。

**签收建议**：项 2–5 直接签收；项 1 在功能口径（路由放行、Content-Type、归属隔离、源对象一致性）下成立，其"逐字节一致"子项在公网 wire 上受 zone 级边缘注入影响无法以原始字节满足——该行为同样作用于 SPA 首页等全部 `text/html` 响应，非本次变更引入。是否按此口径签收项 1，交由单据负责人确认；若需 wire 字节口径下完全一致，需在 Cloudflare zone 配置层面处理（如关闭 HTML 自动压缩/注入类设置），超出本单代码范围。

---

## 1. 生产 fixture（测试对象）

按本单授权"可自建测试对象、测完不留垃圾"铸造，测后已全部精确拆除（核验见 §5）。

| 对象 | 值 |
|------|-----|
| QA 主人 A | 用户 ID `18312`（`qa243a@qa.test`） |
| QA 主人 B | 用户 ID `18313`（`qa243b@qa.test`） |
| A 的令牌 | `qa243-write-a`（行 16）、`qa243-read-a`（行 17） |
| B 的令牌 | `qa243-write-b`（行 18）、`qa243-read-b`（行 19） |
| R2 验收物 1 | `embeds/da25df06-87da-4453-b968-9c7354452a86.html`（363 B，write 令牌上传，201） |
| R2 验收物 2 | `pages/d729fff1-5758-4c0f-97bb-93a22b023e4c.png`（73 B PNG，write 令牌上传，201） |
| R2 验收物 3 | `pages/bed75453-1a27-4671-97c1-dd2e932545e2.json`（624 B，消毒后场景 JSON，write 令牌上传，201） |

验收物与上传响应见 `qa243-evidence/log/uploaded-*` 与 `qa243-evidence/shots/01-upload-*`。

---

## 2. 逐项签收

### 项 1：embed 读回（200 + Content-Type + 字节一致）

- **标准**：write 令牌上传 embed 后，同主人 read 令牌与 write 令牌分别访问 `GET /api/read/files/embeds/<uuid>.html`，均返回 200、`Content-Type: text/html; charset=utf-8`，正文与上传文件逐字节一致。
- **测法**：A_WRITE 上传（201）后，A_READ 与 A_WRITE 分别 GET 上述 key；响应头与响应体存档；正文与上传文件 `art/embed.html` 及 R2 原对象逐字节比对。
- **结果**：
  - A1（read 令牌）：200，`content-type: text/html; charset=utf-8` ✅；正文 1477 B，与上传文件（363 B）字节不一致 ❌（wire 口径）。
  - A2（write 令牌）：同上，200 + Content-Type ✅，正文 1477 B ❌（wire 口径）。
  - R2 源对象核对：R2 落盘对象 `embeds/da25df06…html` 与上传文件 **逐字节一致**（SHA-256 `487e3735…c00a`）✅。
  - 边缘注入剥离后复核：两次响应剥离 Cloudflare 插入片段（1114 B，见 §4）后与上传文件**逐字节一致** ✅；响应中不含应用侧注入标记（`ciki-embed-height` 不存在）✅。
  - A1 与 A2 两次响应互不相同，差异仅位于注入脚本内的每次请求 cf-ray/时间戳 ✅。
- **证据**：`shots/01-upload-embed.*`、`shots/02-embed-read-token.*`、`shots/02-embed-write-token.*`、`shots/04-r2obj-embed.bin`、`log/edge-injection-diff.txt`、`metrics.txt`、`results.json`（A1/A2/A1B/A2B/A1C/R2OBJ_embed）。
- **判定**：功能与数据面（上传落盘、路由放行、Content-Type）全部符合预期；"正文逐字节一致"在 wire 口径 FAIL，根因明确为 zone 级边缘注入（环境因素，非应用回归，非本变更引入）。

### 项 2：跨账号隔离（404）

- **标准**：他人（主人 B）令牌读同一 key 返回 404，正文 `{"error":"File not found"}`。
- **测法**：B_READ 与 B_WRITE 分别 GET A 上传的 embed key。
- **结果**：B1（B read 令牌）404 `{"error":"File not found"}` ✅；B2（B write 令牌）404 `{"error":"File not found"}` ✅。两种令牌角色行为一致。
- **证据**：`shots/03-embed-other-read-token.*`、`shots/03-embed-other-write-token.*`、`results.json`（B1/B2）。
- **判定**：PASS。

### 项 3：图片 / 场景 JSON 读回与乱拼 key

- **标准**：图片 key、画布场景 JSON key 读回行为与改前一致（200、Content-Type 正确、字节一致）；乱拼/非法 key 仍 404。
- **测法**：
  - R1：A_READ GET `pages/d729fff1…png`，与上传 PNG 逐字节比对。
  - R2：A_READ GET `pages/bed75453…json`，与消毒后落盘对象逐字节比对（上传时服务端 `sanitizeExcalidrawSceneJson` 消毒，1308 B 原始 → 624 B 落盘）。
  - R2OBJ_image / R2OBJ_scene：API 返回正文与 R2 原对象（经 Cloudflare SAPI 直读）逐字节比对。
  - s1–s8：8 种非法/乱拼 key（错误扩展名、错误前缀、大写 UUID、非 UUID、双扩展、路径穿越、不存在 UUID）GET 验证 404。
- **结果**：
  - R1：200 `image/png`，SHA-256 与上传 PNG 一致（`b67f7678…60449`）✅。
  - R2：200 `application/json`，SHA-256 与消毒后对象一致（`c05984fa…4806d`）✅。
  - R2OBJ_image / R2OBJ_scene：API 正文与 R2 对象逐字节一致 ✅。
  - s1–s8：全部 404 `{"error":"File not found"}` ✅（含 `embeds/…55A.html` 大写 UUID 被 key 形状校验拒绝、路径穿越 `..%2f..%2f` 被 404）。
  - "改前一致"的双重支撑：PR diff 仅在 `read.ts` key 形状校验处新增 `EMBED_KEY_RE` 分支、未改动 pages 分支逻辑；且生产实测行为符合既有契约。
- **证据**：`shots/04-image-read-token.*`、`shots/04-scene-read-token.*`、`shots/04-r2obj-image.bin`、`shots/04-r2obj-scene.bin`、`shots/05-malformed-s{1..8}.*`、`results.json`（R1/R2/R2OBJ_*/s1–s8）。
- **判定**：PASS。

### 项 4：agent-guide 与 OpenAPI 描述

- **标准**：`/api/public/agent-guide` 与 `/api/openapi.json` 的描述与新行为一致。
- **测法**：无令牌 GET 两端点，逐条核对关键描述。
- **结果**（D1/D2 均 PASS）：
  - D1：agent-guide 返回 200 `text/markdown; charset=utf-8`；含 embed key 形状句（2 处）、新行为描述（跨账号隔离、归属校验）、契约版本行 `契约版本：1.0.0` ✅。
  - D2：openapi.json 返回 200；`/api/read/files/{key}` 端点描述含"读取图片、场景 JSON 或 Embed HTML 资产。服务端严格比对上传者账号，非本账号上传回 404."；key 参数描述含 `embeds/<uuid>.html`；全文档 `repositoryUrl` 出现次数为 0；`PublicInfoResponse` 必填恰为 `name/version/openapi/agentGuide` 四字段 ✅。
- **证据**：`shots/06-agent-guide.*`、`shots/07-openapi.*`、`results.json`（D1/D2）。
- **判定**：PASS。

### 项 5：`/api/public` 字段

- **标准**：响应不含 `repositoryUrl`，其余字段逐项一致。
- **测法**：无令牌 GET `/api/public`，比对完整 JSON。
- **结果**（D3 PASS）：响应恰为
  ```json
  {"name":"Ciki","version":"v1.0.0-307-9035f6e","openapi":"/api/openapi.json","agentGuide":"/api/public/agent-guide"}
  ```
  字段集合恰为 4 项、无 `repositoryUrl`、version 短哈希 = 被验 commit `9035f6e` ✅。
- **证据**：`shots/08-public.*`、`results.json`（D3）。
- **判定**：PASS。

---

## 3. 主断言明细

23 条断言的完整机器可读结果见 `qa243-evidence/results.json`。汇总：

| 分组 | 断言 | 结果 |
|------|------|------|
| 项 1 wire 字节 | A1、A2 | FAIL（边缘注入） |
| 项 1 R2 对象 | R2OBJ_embed | FAIL（API 正文 ≠ R2 对象，同根因；R2 对象本身与上传文件一致） |
| 项 1 剥离复核 | A1B、A2B、A1C | PASS |
| 项 2 | B1、B2 | PASS |
| 项 3 行为 | R1、R2、R2OBJ_image、R2OBJ_scene | PASS |
| 项 3 乱拼 key | s1–s8 | PASS |
| 项 4 | D1、D2 | PASS |
| 项 5 | D3 | PASS |

---

## 4. 环境差异：Cloudflare 边缘对 `text/html` 响应的注入

**现象**：embed 读回响应（1477 B）与上传文件（363 B）不一致，首个差异偏移 348，尾部 16 B 相同，中间插入 1114 B。

**根因**：Cloudflare zone 在所有 `text/html` 响应中注入 challenge-platform 脚本（`/cdn-cgi/challenge-platform/scripts/jsd/main.js` 相关代码与 `window.__CF$cv$params`）。注入片段内嵌每次请求的 cf-ray/时间戳，因此：
- 同一对象的两次读回响应互不相同（A1 cf-ray `a6077ff659b5b5d4-LAX`，A2 `a6077ffee918adfc-LAX`）；
- 任何"逐字节一致"断言在 wire 口径下不可能通过。

**注入为 zone 级、非应用侧的判据**：
1. 注入片段含 Cloudflare 专有标识 `cdn-cgi` 与 `__CF$cv$params`；
2. 无令牌 GET SPA 首页 `/`（`shots/09-spa-root-edge-injection.html`）同样被注入同款片段；
3. 应用代码中无 `ciki-embed-height` 等注入痕迹，响应头无应用侧变换标记；
4. Markdown 形态的 agent-guide（`text/markdown`）不被注入——注入精确跟随 `text/html`。

**数据面完整性独立证据**：R2 源对象 `embeds/da25df06…html` 与上传文件逐字节一致（SHA-256 同为 `487e3735…c00a`），即应用写入与存储均正确，唯一失真发生在 Cloudflare 边缘向客户端回源的最后一跳。

**剥离验证**：从 A1/A2 响应中切除已知注入片段（头 348 B 原文 + 注入 1114 B + 尾 16 B 原文结构）后，剩余正文与上传文件逐字节一致（A1B/A2B PASS）。比对脚本与全过程输出见 `log/edge-injection-diff.txt`。

**无凭证复现**（无需令牌，验证注入本身）：

```bash
curl --noproxy '*' -s https://ciki.oneboy.app/ | grep -c '__CF$cv$params'
# 输出 ≥1 即 zone 级注入存在于所有 text/html 响应
```

**完整链路复现**：`qa243-evidence/scripts/` 下 `mint.js` → `mkfiles.js` → `run.sh` → `strip-check.py` 可完整重跑（需生产授权与凭证，脚本不含任何明文令牌）。

**对产品的含义（建议，不在本单处理）**：若 embed HTML 的字节一致性对下游消费方重要，需评估 zone 设置（如 Rocket Loader / Email Obfuscation / challenge 注入）对该路径的影响，或让消费方改用 R2 直读等不经 HTML 变换的通道。属环境配置议题，非代码缺陷。

---

## 5. 生产改动与拆除核验

**写入清单**（全部为本次 fixture）：D1（`ciki`，`af4434ef-c73f-4c69-80b7-56695e6737fe`）2 users + 4 api_tokens；R2（`ciki-assets`）3 个对象。

**拆除**：R2 三 key 逐一精确 `DELETE`（无批量删除）；D1 按 `api_tokens` → `users` 顺序删除行。

**核验结果**：
- 已删 3 个 R2 key 经 SAPI 读回全部 404；
- D1 计数回到基线：users=4、spaces=8、space_members=21、pages=389（active 387）、api_tokens=9、sessions=14、comments=8、notifications=0；QA 专用行残留 0（`qa_users=0 qa_tokens=0 qa_counters=0`）；
- 已吊销令牌实测：A_READ / B_WRITE 调 `/api/read/spaces` 返回 401，令牌确已失效；
- R2 全量 LIST 前后快照对比：`r2-before.tsv`（1389 对象）与 `r2-after.tsv`（1390 对象）唯一差异为 `embeds/141c80c2-7085-4703-ab4c-9bf5f22bb1a3.html`——**测试期间他人并发上传的真实内容**（14602 B，标题为"统一内存管理 UMM…"，内容与本次验收物无关），非本单验收物，已保留未触碰；
- 过程日志：`log/baseline-and-teardown.txt`；快照与比对脚本：`scripts/teardown.sh`。

**凭证卫生**：令牌明文仅存于 `/tmp/qa243/tokens.env`（chmod 600），未进仓库、未进报告；证据目录经扫描仅含 SHA-256 内容摘要，无令牌明文。`/tmp/qa243/tokens.env` 已在收尾时删除。

---

## 6. 证据目录与复跑

```
qa/qa243-evidence/
├── results.json                  # 23 条主断言的机器可读结果
├── metrics.txt                   # 验收物/R2/API 正文的 SHA-256 对照
├── shots/                        # 全部 HTTP 响应头与响应体（按断言编号命名）
│   ├── 01-upload-*.              #   write 令牌上传 201 响应
│   ├── 02-embed-{read,write}-token.*   # A1/A2
│   ├── 03-embed-other-*-token.*  #   B1/B2
│   ├── 04-{image,scene}-read-token.* / 04-r2obj-*.bin   # R1/R2/R2OBJ
│   ├── 05-malformed-s{1..8}.*    #   乱拼 key 404
│   ├── 06-agent-guide.* / 07-openapi.* / 08-public.*    # D1/D2/D3
│   └── 09-spa-root-edge-injection.html  # zone 注入旁证
├── log/
│   ├── edge-injection-diff.txt   # 注入片段定位与剥离验证全过程
│   ├── baseline-and-teardown.txt # 生产基线与拆除核验
│   └── uploaded-*                # 验收物原文件
└── scripts/                      # 脱敏脚本（运行时读令牌，不内嵌明文）
    ├── mint.js / mkfiles.js / run.sh / strip-check.py / teardown.sh
    └── d1q.sh / r2.sh            # D1 / R2 只读与精确清理工具
```

复跑顺序：`mint.js`（铸造）→ `mkfiles.js`（生成验收物）→ 上传 → `run.sh`（主断言）→ `strip-check.py`（剥离复核）→ `teardown.sh`（拆除+终核）。所有脚本从环境/本地文件读取凭证，运行需生产写入授权。

---

## 7. 验收结论

- **项 2、3、4、5**：全部通过，建议签收。
- **项 1**：功能口径通过（200、`text/html; charset=utf-8`、跨账号隔离正确、R2 源对象与上传文件逐字节一致、剥离边缘注入后正文逐字节一致）；**wire 原始字节口径 FAIL**，根因为 Cloudflare zone 级 `text/html` 注入（环境因素，SPA 首页同样受影响，非本变更引入）。是否按此口径签收，交由单据负责人确认；若需消除，走 Cloudflare zone 配置评估，建议另开后续单。
