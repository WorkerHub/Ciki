# QA #205 — Agent 头像裁剪验收报告（Jim 真跑）

- **验收对象**：todo #205；实现单 #204（PR #272，commit `c5b0255` = main HEAD）
- **执行**：2026-11-25，Playwright 真实浏览器操作（Chrome for Testing，chromium-1255）
- **结论**：**通过 — 5/5 项全绿；主运行 35/35 断言 + 补充重放 11/11 断言，零放水**

---

## 0. 生产版本门 ✅

| 核对项 | 值 | 证据 |
|---|---|---|
| 生产 `GET /api/public` | `version: v1.0.0-284-c5b0255` | `qa205-evidence/metrics/prod-public.json` |
| 被测 commit `git describe` | `v1.0.0-284-gc5b0255`（短 SHA `c5b0255`） | 本地同 commit 构建 |
| 生产前端含功能 chunk（只读） | `assets/AvatarCropDialog-C_bT9abH.js` 含 `data-testid="crop-box"` 与 key `profile.avatar.decodeFailed`；`assets/SettingsPage-rz_39PQp.js` 含 `settings.agents.avatar.uploaded`；共享 chunk `assets/api-B4YB4xqB.js` 含全部中文文案值（裁剪头像 / 图片解码失败，请更换图片重试。/ 缩放选区 / Agent 头像已更新。/ 为 {{name}} 选择头像 / 上传头像） | `qa205-evidence/metrics/markers.json`（含 SHA256 与复验方法，共抓取 110 个 chunk 逐文件 grep） |

说明：生产 `index.html` 存在边缘缓存（首次抓到旧部署入口 `index-99Hme72b.js`，该文件在新部署已 404→SPA 回退）；以 `Cache-Control: no-cache` 复抓的 `index-B4sJZhzK.js` 为准。生产 chunk 哈希与本地同 commit 构建不同属预期（`scripts/build-info.mjs` 注入构建号/时间戳，每次构建内容必变）。

## 1. 测试环境（同 commit 本地生产等价实例真跑）

生产注册已关闭（`/api/auth/config` → `registrationEnabled:false`）且无生产凭据；按 #206/#48 先例**不做生产写入**，以同 commit 本地生产等价实例执行：

1. `git clone`（本地只读克隆）→ `/tmp/qa205/repo` @ `c5b0255`（树干净）
2. `pnpm install --frozen-lockfile` && `pnpm build:web`
3. `worker/.dev.vars`：`ENCRYPTION_KEY`（openssl 生成 32B base64）+ `SETUP_SECRET` + `APP_VERSION=v1.0.0-284-c5b0255`（本机生成，不入库）
4. `wrangler dev --port 8795 --ip 127.0.0.1 --persist-to /tmp/qa205/state` → `/api/public` 返回 `v1.0.0-284-c5b0255`
5. `POST /api/setup`（`X-Setup-Secret`）→ 迁移 schema_v1/v9/v10/v11/v12 全部 applied
6. 注册首个用户即管理员（`qa205@local.test`）；API 创建两个 agent：`qa-agent-alpha`（id=2）、`qa-agent-beta`（id=3），avatarUrl 均为 null
7. Playwright 1.65.1 + Chrome for Testing；注入 `ciki_session` 会话 cookie；`serviceWorkers: block`；页面级请求日志逐条记录 method/path/status（共 46+ 条，见 metrics.json `requests`）
8. 测试图（PIL 生成，四色象限+标识文字）：`qa-a.png` 3000×2000、`qa-b.png` 2400×1600、`qa-c.png` 1600×1200（均非方形大图）；`qa-bad.png` = 250KB 伪随机字节 + PNG 魔数（PIL `UnidentifiedImageError` 确认不可解码；浏览器按扩展名给 `image/png`，可通过前端 `validateImageFile`，命中解码失败路径）

## 2. 逐项签收表

| # | 验收标准 | 测法 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 设置页 Agent 卡换头像：非方形大图 → 裁剪对话框（选区可拖动/缩放）→ 确认后头像更新，落盘文件 512×512 WebP | 为 `qa-agent-alpha` 选择 3000×2000 PNG → 对话框（标题「裁剪头像」）出现、`crop-box` 选区可见 → 指针拖动选区左移 50px（断言位移精确、且选区保持在画布内）→ 缩放滑杆 `End`（断言选区宽 213→4px）→ `Home`（断言恢复短边全幅 213px，即源图 2000px ≥512）→ 点「确定」→ 恰 1 次 `POST /api/me/agents/2/avatar`（200）→ 提示「Agent 头像已更新。」→ 行内头像 `img src` 与 `/api/me/agents` 返回一致 → 带会话 `GET /api/files/avatars/<key>` 取回字节，PIL 验证 | **PASS** | `shots/02-05`（对话框/拖动/缩放/最终选区）、`shots/06`；`metrics.json` 项 1 断言（含请求路径与 200 响应）；`files/alpha-item1.webp` = **WEBP 512×512**（1218B）；D1 `ciki_users` id=2 `avatar_key` 同步写入 |
| 2 | 裁剪对话框中取消 → 头像不变、不发上传请求 | 为 `qa-agent-beta` 选择 2400×1600 → 对话框打开后点「取消」→ 断言该时间窗内头像变更类请求（POST/DELETE）**= 0**、对话框卸载、`beta.avatarUrl` 仍为 null、行内无头像 `img` | **PASS** | `shots/07-08`；`metrics.json` 项 2；补充重放 sup-02 复验「取消前后 avatarUrl 相等」（11/11 通过） |
| 3 | 多 agent 时只更新所选 agent 的头像 | 为 `qa-agent-beta` 上传 → 断言恰 1 次请求且路径为 `/api/me/agents/3/avatar`；`alpha.avatarUrl` 前后字符串相等；D1 终态 id=2 `avatar_key` 为空（项 4b 后）/id=3 更新，各时点 API 返回一一对应 | **PASS** | `shots/09-10`；`metrics.json` 项 3（含 before/after 对比）；`files/beta-item3.webp` = **WEBP 512×512**（1198B） |
| 4 | 解码失败图片走错误提示且不上传；删除头像功能不受影响 | **4a**：为 alpha 选择 `qa-bad.png`（PNG 魔数垃圾字节）→ `role=alert`「图片解码失败，请更换图片重试。」可见、对话框关闭、窗口内上传请求 = 0、`alpha.avatarUrl` 不变。**4b**：点 alpha 行「删除头像」→ `DELETE /api/me/agents/2/avatar`（200）→ 提示「Agent 头像已删除。」、`avatarUrl` 置空、「删除头像」按钮消失、beta 头像不受影响；被删/被替换对象 `GET /api/files/<key>` 全部 404（含首轮运行遗留与重置删除的 key），现存对象 200，本地 R2 blobs 恰剩 2 个（beta + 本人） | **PASS** | `shots/11-12` + `shots/sup-03`（卡片红色错误提示实拍）/`sup-04`；`metrics.json` 项 4a/4b；D1 终态 id=2 `avatar_key=''`；对象 404/200 核对记录见报告 §3 |
| 5 | 资料页自己换头像流程回归，与现状一致 | `/profile` → 「选择头像」→ 裁剪对话框 → 「确定」→ **仅本地预览**（保存按钮出现，窗口内上传请求 = 0，与既有「保存后才上传」行为一致）→ 点「保存」→ 恰 1 次 `POST /api/me/avatar`（200）→ 提示「个人资料已保存。」→ `/api/me.avatarUrl` 更新、顶栏头像同步 → 文件 PIL 验证 | **PASS** | `shots/13-15` + `shots/sup-05`（预览+保存按钮）/`sup-06`（保存后实拍）；`metrics.json` 项 5；`files/profile-item5.webp` = **WEBP 512×512**（1192B） |

## 3. 服务端数据核对

**落盘文件（PIL 13.0 逐个验证）**：

| 文件 | 格式 | 尺寸 | 来源 |
|---|---|---|---|
| `files/alpha-item1.webp` | WEBP | 512×512 | 项 1 alpha 上传后 `GET /api/files/<key>`（带会话） |
| `files/beta-item3.webp` | WEBP | 512×512 | 项 3 beta |
| `files/profile-item5.webp` | WEBP | 512×512 | 项 5 本人 |
| `files/sup-alpha.webp` / `files/sup-profile.webp` | WEBP | 512×512 | 补充重放 |

**D1 终态**（`wrangler d1 execute --local`，表 `ciki_users`）：id=1（本人）`avatar_key=avatars/2f3cf219-….webp`；id=2（alpha）`avatar_key=''`（项 4b 删除后）；id=3（beta）`avatar_key=avatars/c266d6c4-….webp`（项 3 上传）——与各状态时点 API 返回完全一致。

**对象生命周期**：删除/被替换的 avatar key（首轮 alpha `c8e1d98f`、次轮 alpha `f700d6e7`、首轮 beta 重置 `0aeca463`）→ `GET` 全部 404；现存 key（beta `c266d6c4`、本人 `2f3cf219`）→ 200。

**断言留痕**：主运行 35/35（`metrics/metrics.json` → `results`），补充重放 11/11（`metrics/metrics.json` 同目录补充文件随脚本输出落 `sup-metrics.json`，见 `scripts/sup.js`）；请求日志 46+ 条含时间戳/方法/路径/状态码；状态时间线 8 个时点（`stateTimeline`）。

## 4. 边界与说明（不放水声明）

- **未覆盖**：Safari/WebKit 的 `HTMLImageElement` 保 EXIF 分支（本机自动化仅 Chromium）；EXIF 方向摆正属实现细节，本轮验收口径未含。
- 512×512 输出成立的前提是**选区 ≥512 源像素**（`avatar.ts` 以 `min(选区,512)` 输出）；验收口径的「非方形大图默认选区 = 短边全幅」天然满足（本轮 2000/1600/1200 源像素均 ≥512）。
- 服务端 2MB 上限拒绝路径未触发（前端 10MB 校验先行，本轮用例均为小图）——该行为属 #204 之前的既有逻辑，未在本轮口径内。
- 「取消」「解码失败」两类断言均以**窗口内头像变更类请求（POST/DELETE）=0**为准，请求日志逐条可查，非仅看 UI。
- 生产侧只读：仅 `GET /api/public` 与静态资产核对，无任何生产写入。
- 过程中的两次失败均为**测试代码问题**，非应用缺陷：① 资料页卡片标题非 heading 元素导致定位超时（改用 input aria-label 后通过）；② 补充脚本误断言「beta 头像为 null」（重放时 beta 已有头像，改为「取消前后不变」语义后通过）。应用行为无失败用例，无重试到通过的情况。

## 5. 清理

- 本地实例（服务 `qa205-wrangler`，端口 8795）已停止；`/tmp/qa205`（clone、wrangler state、测试图、工具目录）已整体删除。
- 无生产数据变更；本地 D1/R2 状态随 `/tmp/qa205/state` 一并丢弃。

## 6. 复现路径

```bash
# 1) 同 commit 本地实例（secret 均为临时生成，不入库）
git clone <repo> /tmp/qa205/repo && cd /tmp/qa205/repo && git checkout c5b0255
pnpm install --frozen-lockfile && pnpm build:web
EK=$(openssl rand -base64 32); SS=$(openssl rand -base64 24)
printf 'ENCRYPTION_KEY=%s\nSETUP_SECRET=%s\nAPP_VERSION=v1.0.0-284-c5b0255\n' "$EK" "$SS" > worker/.dev.vars
cd worker && pnpm exec wrangler dev --port 8795 --ip 127.0.0.1 --persist-to /tmp/qa205/state

# 2) 初始化 + 数据
curl -s -X POST http://127.0.0.1:8795/api/setup -H "X-Setup-Secret: $SS" -H 'Content-Type: application/json' -d '{"title":"QA205"}'
curl -s -c jar -X POST http://127.0.0.1:8795/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"qa205@local.test","password":"<口令>","displayName":"QA205 Admin"}'   # 首个用户=管理员
# 登录得 ciki_session；POST /api/me/agents 建 qa-agent-alpha / qa-agent-beta

# 3) Playwright 真跑（脚本见 qa/qa205-evidence/scripts/，会话 cookie 从本机 jar 读取）
node qa/qa205-evidence/scripts/run.js    # 主运行 35 断言
node qa/qa205-evidence/scripts/sup.js    # 补充视口截图 + 11 断言

# 4) 落盘核对
python3 -c "from PIL import Image; im=Image.open('alpha-item1.webp'); print(im.format, im.size)"
wrangler d1 execute D1_DATABASE_NAME_PLACEHOLDER --local --persist-to /tmp/qa205/state \
  --command "SELECT id, username, kind, avatar_key FROM ciki_users ORDER BY id"
```

测试图生成与 `qa-bad.png` 构造方法见 §1 第 8 条；生产资产特征复验方法见 `metrics/markers.json`。
