# Ciki 接口 E 单验证报告：二期 + 三期 §7 合并矩阵

- **单据**：Ciki #111《Ciki 接口 E 单验证（二期 #111 扩围）：二/三期 §7 合并矩阵一次验完》
- **执行**：Jim（QA 独立验证，只读核对、不改功能代码）
- **执行时间**：2026-11-12 22:15（北京时间，本机时钟）
- **结论**：矩阵 7 个大项、**36 条子项逐项核对 → 36 通过 / 0 不通过**；本轮运行未发现 bug。
- **只签本次实际跑过的项**：所有结论均来自本机实际执行（命令见「五」）。未执行到、无法覆盖的项单列在「四」，不冒充通过。

## 一、环境（先说清这份结论属于哪一层）

| 项     | 值                                                                             |
| ------ | ------------------------------------------------------------------------------ |
| 机器   | P3685.local（macOS，darwin 25.6.0）                                            |
| 运行时 | Node v26.13.0；Worker 侧另有 workerd（Miniflare，`@cloudflare/vitest-plugin`） |
| 数据库 | 测试替身 `SqliteD1`（Node 内置 `node:sqlite`，内存库）+ 内存图片桶/正文桶      |
| 前端   | jsdom + Testing Library（组件级实测）                                          |
| 生产   | **未连接**。团队无 Cloudflare 写凭据；未对生产 D1/R2 做任何读写                |

> 本地模拟 ≠ 生产实测。生产库为独立 D1 `ciki`（TABLE_PREFIX 无前缀），`schema_v3` 升级点击只能由用户本人在「系统管理 → 数据库维护 → 检查并升级数据库」执行；升级前后的生产数据对账与明文回放**不在本单执行**，本报告不为其背书。

## 二、逐项结论（一项一条）

约定：结论只有「通过 / 不通过」；每条附本次实际观察到的关键证据。

### 1. 迁移（4 条，全部通过）

**1.1 新装形态 — 通过**
空库一次 setup 即最终形态：`api_tokens`（8 列）/ `import_tokens`（7 列、`id` 主键）/ `token_space_scopes`（`(token_id, space_id)` 复合主键）；`read_tokens`、`write_tokens` 已不存在；`api_tokens_token_hash` 与 `import_tokens_token_hash` 唯一索引在位；账本恰为 `schema_v1`、`schema_v2`、`schema_v3`；`kind` 写入非法值被 CHECK 拒绝；新装后管理接口与读接口可直接用。

**1.2 v2 存量升级后令牌数 / scope 行数 / 导入数前后一致 — 通过**
升级前（v1 基线 + 账本 v1/v2 + v2 两表）：只读 2、读写 2（其中 1 枚已吊销）、scope 4 行、导入 2；升级后 `api_tokens` 4 行（read 2 / write 2，吊销 1）、scope 4 行、导入 2 行；hash、`created_at`、`last_used_at`、`revoked_at` 原样，自动名「只读 Token / 读写 Token / 浏览器插件」；范围按 `(user_id, kind)` 精确映射到新令牌行（用户 1 只读→空间 1、读写→空间 2）。

**1.3 存量只读 / 读写 / 导入明文令牌升级后仍可鉴权 — 通过**
只读明文 → `/api/read/spaces` 200 且只看见范围 [1]；读写明文 → 写接口建页 201 + 读接口 200 且只看见 [2]；两枚导入明文 → `/api/import/spaces` 200；已吊销读写 → 读/写均 401；表隔离双向 401（导入进不了读接口、只读进不了导入接口）。

**1.4 幂等重跑 — 通过**
第二次 setup 三条全 `skipped`；账本 3 行与 `api_tokens` / `token_space_scopes` / `import_tokens` 逐行逐字段不变。

### 2. 多令牌（4 条，全部通过）

**2.1 建 2 只读 + 1 读写，吊销其一枚只读 → 其余两支不受影响 — 通过**
被吊销只读立即 401；另一枚只读 200、读写令牌读 200 且建页 201；列表只剩 2 行且 id 与预期精确一致。

**2.2 三支范围互不干扰 — 通过**
三支初始范围 [默认]、[甲]、[默认,甲] 各自可见空间精确匹配；把第一支改成 [乙] 后仅第一支变化，另两支的可见空间与三张 `token_space_scopes` 行原样。

**2.3 改名生效 — 通过**
`PUT /name` 后列表与库内均为「新名字」（前后空白被 trim）；`kind` 仍为 read；原明文仍可鉴权。

**2.4 名称留空自动名 — 通过**
缺键 / 空串 / 纯空白分别落「只读 Token」「读写 Token」「只读 Token」；插件凭证缺键落「浏览器插件」；列表名称集合精确。

### 3. 管理校验（5 条，全部通过）

**3.1 范围空数组 400 — 通过**
`POST /api/me/tokens` 带 `spaceIds: []` → 400 `INVALID_SPACE_SCOPE`，`api_tokens` 与 scope 行数均不变；`PUT .../spaces` 空数组 → 400 且旧范围保留；缺 `spaceIds` 键同样 400（不做部分写入）。

**3.2 不可见空间 400 且零写入 — 通过**
普通用户对「非成员空间」建令牌 → 400 `INVALID_SPACE_SCOPE`，该用户令牌行数与 scope 行数不变；把已有令牌改到不可见空间 → 400，旧范围仍为原值。

**3.3 他人令牌 id 操作 404 — 通过**
他人改名 / 改范围 / 吊销全部 404；目标行 `name`、`revoked_at` 未变，原明文仍可用；不存在的 id 与畸形 id（`abc`）同为 404。

**3.4 名称超限 400 — 通过**
40 码点（含前后空白）201 并按 trim 后存储；41 码点 400 `{"error":"Invalid token name"}`；40 个 emoji 201（按码点计）；改名超限 / 纯空白 / 非字符串均 400 且旧名保留。

**3.5 类型创建后无变更入口 — 通过**
`PUT/POST/PATCH /api/me/tokens/:id` 与 `PUT /tokens/:id/kind` 全部 404；改名、改范围夹带 `kind` 不生效（库里仍 `kind=read`）；建令牌时非法 / 缺失 kind 400。

### 4. 隔离与数据面回归（12 条，全部通过）

**4.1 spaces 形状 / 顺序 — 通过**
外层只有 `spaces`，每项精确 `id/name/slug` 三键；顺序为「默认空间 → Alpha/alpha（同名按创建时间）→ beta → Zeta」；与站内 `/api/spaces` 顺序一致。

**4.2 范围收窄在 tree/search/pages/spaces 一致 — 通过**
范围 [空间 B] 时 spaces 只列 B、tree 只出 B 的页面、search 只命中 B、A 的页面直链 404；清空范围（`null`）后同一明文四个接口一起放开。

**4.3 写四端点 — 通过**
建页 201 精确六键并排同级末尾；改正文追加 version 2、只改标题不产版本；移动换父成功；删除为软删；`created_by`/`updated_by` 记为令牌主人，HTML / 纯文本 / MD 三列由同一写路径生成。

**4.4 移动稠密重排 — 通过**
三根页移动后 `sort_order` 为 0,1,2 且与库内顺序一致；移入子级后子级 `sort_order` 为 0,1,2；`/api/read/tree` 顺序与「空间 → 同级顺序 → 创建时间」完全一致。

**4.5 软删进回收站 — 通过**
写接口删母页后整棵子树从 tree / search 消失、直链皆 404；站内回收站只列母页；恢复后子树回到树中并重新命中搜索。

**4.6 JSON 往返保真 — 通过**
富结构 JSON（标题、粗/斜/行内码/链接、列表、代码块、引用、表格、分割线）按原文落库，`?format=json` 读回**字节级相等**；派生 MD 各元素正确；把读回的原文再写一次不追加版本。

**4.7 read kind 进写接口 401（五端点） — 通过**
只读令牌与「已吊销的读写令牌」对建页 / 改页 / 移动 / 删页 / 上传五个端点全部 401，且响应头 `Cache-Control: no-store`。

**4.8 三令牌双向隔离 + 会话↔令牌 — 通过**
接口令牌（read/write）调 `/api/import/*` 401；导入凭证调 `/api/read/*` 与 `/api/write/*` 401；会话 Cookie 调三类令牌入口 401；三类令牌调 `/api/me`、`/api/me/tokens` 401。

**4.9 吊销一律 401 — 通过**
三类令牌各吊销一枚后全部 401（读写令牌读、写各测一次）；同用户未吊销的只读与导入令牌仍 200。

**4.10 `last_used_at` 按命中令牌行更新 — 通过**
两枚只读 + 一枚读写 + 一枚导入：只调 B 与读写/导入后，A 的 `last_used_at` 仍为 null，B、读写、导入各自被刷新（三张表分表统计）。

**4.11 限流桶不变（read / write / 失败） — 通过**
正常调用只产生 `read` / `write` 桶（无新桶名）；read 计数 3000 → 429 `RATE_LIMITED`、write 600 → 429、read/write 失败桶按 IP 20 → 429（先拒后验）。

**4.12 创建令牌限流按 kind 分桶 — 通过**
只读第 11 次创建 429 `RATE_LIMITED`；同一用户建读写令牌仍 201（两桶互不影响）。

### 5. 写接口第五端点（4 条，全部通过）

**5.1 上传成功且形状与 `/api/import/files` 一致 — 通过**
两个端点均 201 且精确四键 `key/url/contentType/size`；写接口落 `pages/`、导入落 `imports/`；`url=/api/files/<key>`，`contentType` 与 `size` 一致，对象确实进图片桶。

**5.2 read kind / 吊销 401 — 通过**
只读令牌、已吊销读写令牌、导入凭证、伪造令牌、会话 Cookie 调 `/api/write/files` 全部 401（`no-store`）。

**5.3 上传引用写进 `content_json` 建页，读回 HTML 含文件地址 — 通过**
上传得到的 `url` 写进 `content_json` 建页 201；站内详情 `contentHtml` 含 `/api/files/pages/<uuid>.png` 且无 `data-original-src`（未被判成未转存）；读接口 JSON 含同一地址，MD 补成绝对地址 `https://ciki.oneboy.app/api/files/pages/...`。

**5.4 受范围限制的 write 令牌可上传，但引用建页到范围外空间仍 404 — 通过**
范围 [默认空间] 的读写下令牌上传 201（上传无空间维度）；带同一引用到范围外空间建页 404 `SPACE_NOT_FOUND`，该空间页面数前后不变。

### 6. 导入多凭证（3 条，全部通过）

**6.1 两支凭证都能调 `/api/import/*`，吊销一支只断一支 — 通过**
两支凭证各自 `spaces` 200 并各建一页 201；吊销第一支后它 401、第二支仍 200；列表只剩「插件乙」；重复吊销第一支 404（不幂等）。

**6.2 插件契约回归（spaces / parents / check / files / pages） — 通过**
spaces 精确 `id/slug/name`；parents 精确 `id/title/parentId` 且建页后出现；check `{exists:false}` → `{exists:true,pageId}`；files 四键落 `imports/`；pages 新建 201 / 覆盖 200，响应均精确 `{pageId,url}`；非法 conflict 400、空间不存在 404、无权空间 403。

**6.3 导入调用限流不变 — 通过**
`import` 计数 3000 后调用 429 `RATE_LIMITED`。

### 7. 前端（4 条，全部通过）

**7.1 两卡列表 / 新建 / 改名 / 改范围 / 吊销全流程 — 通过**
API Token 卡在**同一组件实例**里连续完成：列表（类型徽标、范围摘要、使用时间）→ 新建（切读写 + 名称 + 指定空间，提交三字段精确 `{kind:"write",name:"验证用读写",spaceIds:[2]}`）→ 明文 → 改名（`renameToken(7,"外部只读")` 后按服务端回执重拉）→ 改范围（`setTokenSpaces(7,[2])` 且创建未被再次调用）→ 吊销（二次确认后才调用，行消失）。浏览器插件卡：列表 → 新建（留空不带 name）→ 明文 → 吊销，全流程通过。

**7.2 明文只出现一次 — 通过**
明文只在创建后的 code 块出现 1 次；「我已保存」后从 DOM 消失；组件重挂载后不再出现；`localStorage` / `sessionStorage` / 整页文本均无残留。

**7.3 中英切换文案正确 — 通过**
zh：`API Token` / `新建 Token` / `还没有 API Token` / `留空将自动命名：只读 Token` / `浏览器插件`；切 en：`New Token` / `No API Token yet` / `Leave blank to name it Read-only Token` / `Browser extension`；切回 zh 文案复原，无中文残留。

**7.4 中文保留 Token 英文词 — 通过**
中文标题、按钮、空态、自动名提示、明文提示全部保留英文词 `Token`（未硬译成「令牌/凭证」）；同一断言在语言切换前后都复核过。

## 三、同一次运行的全量回归（无回归）

| 套件                          | 命令                                                                  | 结果                                                                                |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Worker（Node 环境）           | `cd worker && pnpm exec vitest run`                                   | 48 文件 / **569 通过 / 0 失败**（基线 537 + 本单 32）                               |
| Worker（workerd / Miniflare） | `cd worker && pnpm exec vitest run --config vitest.workers.config.ts` | 5 文件 / **18 通过 / 0 失败**                                                       |
| Web（jsdom）                  | `cd web && pnpm exec vitest run`                                      | 65 文件 / **697 通过 / 0 失败**（基线 693 + 本单 4）                                |
| 静态与构建                    | `pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm build`      | 全部通过（367 文件格式检查、368 文件 lint 无问题；web/worker typecheck 与构建成功） |

## 四、未覆盖与限制（明说，不冒充）

1. **生产未实测**：团队无 Cloudflare 写凭据，未连生产 D1/R2。生产 `schema_v3` 升级点击、升级前后生产数据计数对账、存量明文在生产上的回放，**均不在本单执行**，本报告不为生产结果背书。
2. **迁移只在本地 SQLite 验证**：`SqliteD1`（`node:sqlite`，D1 替身）覆盖了表结构、FTS5、`db.batch()` 回滚与约束，但真实 D1 的批处理与授权行为未在本单再验一次；workerd 套件只覆盖渲染与 zip 路径，不含迁移。
3. **前端为组件级实测**：jsdom + Testing Library 断言 DOM 与交互调用，未在真浏览器做视觉/像素走查（本单无视觉改动，矩阵只要求流程与文案）。
4. **R2 为内存替身**：上传的四键响应、落盘前缀与对象存在性已验证，未验证真实 R2 的 `customMetadata` 与读回字节。
5. **未做的旁证**：用户被停用后令牌即时失效、成员退出空间后范围收窄属主单自测覆盖范围，本单未重复执行（不影响矩阵结论）。

## 五、复现命令

```bash
# 后端独立验证（36 条里的 32 条）
cd worker && pnpm exec vitest run test/e-verify-phase2-3.test.ts

# 前端独立验证（36 条里的 4 条）
cd web && pnpm exec vitest run src/components/e-verify-tokens.test.tsx

# 全量回归与 CI 同口径检查
cd worker && pnpm exec vitest run
cd worker && pnpm exec vitest run --config vitest.workers.config.ts
cd web && pnpm exec vitest run
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build
```

## 六、本轮变更（只有验证产物，无功能代码）

- 新增 `worker/test/e-verify-phase2-3.test.ts`：矩阵第 1–6 节的独立验证用例（独立布景与断言，不复用主单自测；其中的 v2 存量库按 v1 基线 + v2 两表重建，令牌用可回放明文灌入）。
- 新增 `web/src/components/e-verify-tokens.test.tsx`：两卡全流程、明文一次、中英切换的独立验证。
- 新增本报告。
- **未改任何产品代码**（`worker/src/**`、`web/src/**` 的非测试文件、`docs/api-contract.md` 均未动）。

## 七、下一步

- **负责人：Chief** → 动作：按 review 关口流程处理本单（纯验证交付、无代码改动）→ 触发条件：本分支 CI 绿后即可递合并关口。
- **用户**：合并并部署后，由用户本人在「系统管理 → 数据库维护」点「检查并升级数据库」完成生产 `schema_v3` 升级；点击前按 `wrangler d1 time-travel info <库名>` 记下 bookmark 作为回退点。
- **Jim**：如生产升级后需要，可另开只读复核单核对生产升级回执（本单不含）。
