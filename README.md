# Ciki

[English](./README.en.md) | 中文

Ciki 是团队内部使用的 wiki：页面按空间与树形层级组织，支持多成员协作、版本历史与全文检索。一个 Cloudflare Workers 部署单元同时托管 API 与前端静态资源：结构化数据在 D1，页面正文与图片分别在两个 R2 桶里。

## 界面预览

| 阅读页（代码块与表格）                        | 编辑页                                        |
| --------------------------------------------- | --------------------------------------------- |
| ![阅读页](.github/assets/imgs/page-view.webp) | ![编辑页](.github/assets/imgs/page-edit.webp) |

| 页面树（三层）                                | 搜索                                     |
| --------------------------------------------- | ---------------------------------------- |
| ![页面树](.github/assets/imgs/page-tree.webp) | ![搜索](.github/assets/imgs/search.webp) |

| 空间切换                                                            | 空间设置与成员                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ![空间切换](.github/assets/imgs/spaces/space-switcher-desktop.webp) | ![空间设置](.github/assets/imgs/spaces/space-settings-desktop.webp) |

| 登录                                    | 移动端阅读                                 |
| --------------------------------------- | ------------------------------------------ |
| ![登录](.github/assets/imgs/login.webp) | ![移动端](.github/assets/imgs/mobile.webp) |

| 设置（主题与两步验证）                     | 系统管理                                    |
| ------------------------------------------ | ------------------------------------------- |
| ![设置](.github/assets/imgs/settings.webp) | ![系统管理](.github/assets/imgs/admin.webp) |

| 深色主题                                             | 关于（构建信息）                        |
| ---------------------------------------------------- | --------------------------------------- |
| ![深色主题](.github/assets/imgs/page-view-dark.webp) | ![关于](.github/assets/imgs/about.webp) |

截图是本地真跑（`wrangler dev` + 本地 D1/R2）录的，示例内容全部虚构。

## 功能特性

- **多空间与成员权限** — 每个空间有独立的成员名单，角色分 `admin` / `editor` / `viewer`；普通用户只看得见自己加入的空间，站点管理员可见全部。
- **页面树** — 侧边栏树形组织，拖拽调整层级与顺序；页面可在空间内移动，也可把整棵子树移到别的空间。
- **编辑器** — TipTap 3；代码块浅色高亮、语言角标与复制按钮（编辑态与阅读态一致），表格可拖拽列宽，图片直接上传到 R2。
- **版本历史** — 每次保存生成一条版本记录，可查看旧版并回滚；回滚本身也生成一条新版本。
- **全文检索** — 顶栏搜索框，标题与正文都命中，FTS5 + CJK 分词，结果页给出命中片段。
- **回收站** — 删除页面时整棵子树一起软删除，可恢复或彻底删除；彻底删除会连版本历史一起清掉。
- **登录与两步验证** — 账号密码 + TOTP / Passkey；首个注册用户自动成为管理员，之后注册默认需要管理员批准；新增第二种验证方式需要重新输入一次密码。
- **导入令牌** — 在设置页生成个人令牌，配套浏览器扩展「Ciki助手」用它把源站页面整页剪藏进 Ciki（标题、正文、代码块、表格与图片）；令牌明文只显示一次。
- **设置** — 外观（亮 / 暗 / 跟随系统，首屏不闪烁）、修改密码、两步验证、导入令牌、登录设备管理。
- **系统管理** — 用户与注册审批、空间总览、应用设置（站点名称、开放注册、注册审批、初始化页开关）、访问与安全（强制两步验证）、邮件配置（SMTP 服务器与测试发信）、数据库维护。
- **关于** — 版本号与构建时间，由 CI 在构建时注入。
- **移动端适配** — 响应式布局，阅读、页面树与空间切换在手机上可用。

## 技术栈

- **后端**: Cloudflare Workers + Hono（TypeScript），D1（SQLite）+ FTS5 全文检索
- **前端**: React 19 + Vite + TypeScript，Tailwind CSS v4，shadcn/ui（Nova 风格）+ Kumo + Radix UI
- **编辑器**: TipTap 3（StarterKit / CodeBlockLowlight / Table / TaskList / Image / Link / Underline）
- **存储**: D1 存页面、版本与用户数据，R2 存图片，Worker 同时托管前端静态资源
- **交互基础**: react-resizable-panels（分栏）、dnd-kit（页面树拖拽）、Zustand（状态）、Lucide（图标）、Motion（动效）
- **工程与部署**: pnpm monorepo，GitHub Actions + Wrangler
- **接口契约**: 见 [`docs/api-contract.md`](docs/api-contract.md)

## 部署指南

### 前置要求

- Cloudflare 账户，已开通 Workers、D1 与 R2（R2 首次使用需在控制台启用）
- GitHub 账户，用来把仓库 fork 到自己账号下（部署工作流在你 fork 出的仓库里跑）
- 只有本地开发才需要本机装 Git、Node.js 22 或更高版本与 pnpm（`corepack enable` 会自动使用仓库锁定的 pnpm 版本）；部署用不到

### 1. Fork 仓库

打开 <https://github.com/WorkerHub/Ciki>，点右上角 **Fork**，fork 到自己的账号下，保持公开即可。以后要拿上游更新，在 fork 仓库首页点 **Sync fork**。

fork 出来的仓库，工作流默认是关着的，先启用：

- 打开 fork 仓库的 **Actions** 标签页，按页面提示点 **I understand my workflows, go ahead and enable them**（中文界面：「我已了解我的工作流，继续启用」）。
- 启用之后，**Actions → Deploy → Run workflow** 就能手动触发部署。

### 2. 创建 Cloudflare 资源

**D1 数据库**（存页面、版本、用户等数据）

- 打开 Cloudflare 控制台 → Storage & Databases → D1 SQL Database → Create database，名称填 `ciki`（可自定义）。
- 创建后进入数据库详情页，记下 **Database name** 与 **Database ID**，下一步要填。
- Ciki 的表名默认带 `ciki_` 前缀，因此也可以复用已有的 D1 库，不会和同库里其它项目串表。

**R2 bucket**（存图片与正文）

需要**两个**桶，名字与绑定固定（写在 `worker/wrangler.toml` 与部署工作流里）：

- `ciki-assets`（绑定 `R2`）：页面上传的图片与头像。
- `ciki-content`（绑定 `CONTENT`）：页面正文与历史版本正文。

- 部署工作流会幂等补建这两个桶：不存在就创建，已存在就跳过。也可以先在控制台 → R2 Object Storage → Create bucket 手动建好，名字必须逐字一致。
- 部署用的 `CLOUDFLARE_API_TOKEN` 需要有 **R2 编辑**权限，否则补建 bucket 这一步会让部署失败（此时还没有部署任何东西）。

### 3. 配置 GitHub Secrets 与 Variables

打开 fork 仓库的 Settings → Secrets and variables → Actions。资源 ID 放 **Secrets**（GitHub 会自动打码），库名与表前缀这类非机密放 **Variables**。

**Secrets**（切到 Secrets 标签页 → New repository secret，逐个添加）

| Secret                  | 用途                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token。可用「Edit Cloudflare Workers」模板，并确认权限里有 Workers Scripts 编辑、D1 编辑与 R2 编辑（缺哪个补哪个）。部署与 Worker 运行时共用这一把：Worker 调 D1 REST API 读取库体积也用它，因此需含 D1 读（「D1 编辑」已包含） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID（控制台首页右侧可复制）                                                                                                                                                                                                     |
| `D1_DATABASE_ID`        | 上一步记下的 D1 Database ID                                                                                                                                                                                                                    |
| `ENCRYPTION_KEY`        | TOTP 密钥的 AES-GCM 加密钥，32 字节，base64（44 字符）或 hex（64 字符）均可。生成后先在密码管理器留底；部署后不要更换，否则已绑定的两步验证会全部失效，需要重新绑定                                                                            |
| `SETUP_SECRET`          | 初始化数据库用的令牌，任意随机字符串（例如 32 位 hex）                                                                                                                                                                                         |
| `WAKER_SIGNING_KEY`     | **可选**。不配 → Worker 内置 Cron 每月自动清理 R2 孤儿对象；配 waker 建项目时给的 key → 改由 waker 回调触发；配 `false` → 关闭自动清理。只写进 GitHub Secrets、不要进仓库                                                                      |

**Variables**（切到 Variables 标签页 → New repository variable）

| Variable           | 用途                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `D1_DATABASE_NAME` | D1 数据库名（明文，非机密）                                                                                  |
| `TABLE_PREFIX`     | 表前缀，可选。不设置或留空 → `ciki_`；填 `none` → 无前缀；填其他值（如 `wiki`）→ `wiki_`。详见附录「表前缀」 |

**不用终端生成密钥**：浏览器打开任意页面，按 F12 → Console，跑下面这行得到 44 字符 base64（32 字节）：

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

跑这行得到 64 位 hex：

```js
Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
  b.toString(16).padStart(2, "0")
).join("")
```

`SETUP_SECRET` 只要求随机，两条结果都能用。习惯命令行的，`openssl rand -base64 32` 与 `openssl rand -hex 16` 等价。

以上 5 个必需 Secret（外加可选的 `WAKER_SIGNING_KEY`）与 2 个 Variable 就是部署需要的全部配置：`deploy.yml` 只引用这些名字。缺任何必需项，或值仍是模板里的 `*_PLACEHOLDER` / `replace-with-*`，或 `ENCRYPTION_KEY` 不是 32 字节，部署都会在上传前中止并点名，不会用空值或占位值顶替；`WAKER_SIGNING_KEY` 留空只表示「走内置 Cron」，不会让部署失败。

### 4. 部署

到 **Actions → Deploy → Run workflow** 手动触发部署。

部署工作流按顺序做四件事：构建前端 → 解析 secrets 与 `wrangler.toml` 占位符 → 补建 R2 bucket → `wrangler deploy`。表结构不在这一步创建，接着做初始化。

### 5. 初始化数据库

部署成功只代表 Worker 上线，表还没有建。用浏览器打开站点：未初始化时会自动跳转到 `/setup` 初始化页。

1. 填入 `SETUP_SECRET`（只放在请求头 `X-Setup-Secret`，不会进 URL）。
2. 提交后接口只跑迁移，页面会显示生效的表前缀与已执行的迁移列表，核对前缀与预期一致。

**可选**（需要本地终端）：习惯命令行的话，也可以在本机用 curl 完成同一步，输入不回显、不进命令历史：

```bash
read -rs SETUP_SECRET
curl -X POST https://<你的站点域名>/api/setup -H "X-Setup-Secret: $SETUP_SECRET"
unset SETUP_SECRET
```

每次升级部署后，管理员在「系统管理 → 数据库维护」点一次「检查并升级数据库」即可补跑迁移（`POST /api/admin/setup`，登录管理员会话即可，不需要 `SETUP_SECRET`）。已执行的迁移显示为 `skipped`；界面不提供删表 / 清库入口。

### 6. 注册管理员

初始化完成后打开站点首页注册账号。第一个注册用户自动成为管理员、直接批准并激活；此后的注册默认需要管理员批准。可在「系统管理 → 应用设置」调整是否开放注册与是否需要批准。

## 本地开发

本地跑需要本机装 Git（用来克隆仓库）、Node.js 22 或更高版本与 pnpm：

```bash
git clone https://github.com/<你的 GitHub 账号>/Ciki.git
cd Ciki
pnpm install
cp worker/.dev.vars.example worker/.dev.vars   # 填入本地 ENCRYPTION_KEY / SETUP_SECRET
pnpm dev
```

`pnpm dev` 先构建一次前端（`web/dist` 是 Worker 的静态资源目录），再用 `concurrently` 同时起：

- Worker：`wrangler dev`，默认 <http://localhost:8787>；本地 D1/R2 由 miniflare 模拟，不需要 Cloudflare 账号。
- Web：`vite`，默认 <http://localhost:5173>，`/api` 代理到 8787。

`worker/.dev.vars` 已被 gitignore，真实密钥不进仓库。`TABLE_PREFIX` 可选：不配置 → `ciki_`，写空值 → 无前缀（保留字 `none` 只在 CI 侧翻译）。

## 校验

```bash
pnpm lint          # biome lint
pnpm format:check  # biome format
pnpm typecheck     # web + worker
pnpm build         # 前端产物 + worker 类型检查
pnpm test          # worker 单测 + web 单测（vitest + jsdom）
pnpm check:deploy  # wrangler deploy --dry-run：校验绑定与打包
```

CI 按顺序跑这六条；其中 `check:deploy` 会在部署前确认 D1 / R2 / 静态资源三类绑定可解析、Worker 能打包，不会真正上传或改动线上资源。

## 目录结构

```
.github/workflows/   CI（校验）与 Deploy（部署）
docs/                API 契约与数据模型
scripts/             部署期配置解析（表前缀三态、secrets.json、wrangler.toml 占位符）
web/                 React + Vite 前端（构建产物 web/dist 由 Worker 托管）
worker/              Hono Worker（D1 / R2 / 静态资源三类绑定）
```

### 前端代码地图

```
web/src/editor/paste/  外部 HTML 清洗管线（含样本与断言）
web/src/editor/        TipTap 扩展集（编辑/阅读共用）、代码块与图片 NodeView、工具条、扩展桥
web/src/lib/           API 客户端（唯一 HTTP 出口）、列宽换算、页面树算法、主题、上传
web/src/stores/        Zustand：会话、页面树、空间、主题
web/src/pages/         阅读/编辑/搜索/回收站/设置/关于/系统管理/空间设置/登录注册初始化
```

## 接口与数据模型

完整的接口、字段、错误码与迁移说明见 [`docs/api-contract.md`](docs/api-contract.md)。

- 除公开端点与导入接口外，所有 `/api/*` 都要带会话 Cookie（`ciki_session`，HttpOnly / Secure / SameSite=Strict，7 天滑动续期）。
- 导入接口 `/api/import/*` 只认 `Authorization: Bearer <个人导入令牌>`，不接受会话 Cookie。Ciki助手用它查可写空间与父页、检查同名页、上传图片和写页面；令牌在设置页生成，明文只显示一次。
- 图片经 `/api/files/:key` 读取，必须带登录会话，不提供公开直链。

## 许可证

[MIT](LICENSE)

## 附录

#### 表前缀 TABLE_PREFIX（可选）

所有表名都由 `worker/src/lib/table-prefix.ts` 的 `getTablePrefix()` 拼出；`TABLE_PREFIX` 只影响本项目的表，适合在一个 D1 库里和别的项目共处。

| 配置                                                                                             | 生效前缀 | 表名示例     |
| ------------------------------------------------------------------------------------------------ | -------- | ------------ |
| 不设置 / 留空（默认）                                                                            | `ciki_`  | `ciki_pages` |
| 自定义值（如 `wiki`：非空时须以字母或下划线开头，其后只允许字母、数字、下划线，尾部 `_` 自动补） | `wiki_`  | `wiki_pages` |
| `none`（GitHub Variables 的保留字，表示显式置空）                                                | 无前缀   | `pages`      |

生效前缀必须在初始化前定好：换前缀等于换一套空表。初始化接口检测到库里已在另一前缀下初始化时，会以 409 中止，不会另建第二套表。

#### 月度 R2 清理（可选）

R2 里的孤儿对象每月自动清理一轮，**图片桶与内容桶各跑一遍、各记各的账**（`r2_cleanup_runs.kind` = `images` / `content`），只删「不在引用集内、且对象 uploaded 距今超过 30 天」的对象：

- 图片桶（`ciki-assets`）：引用集 = 全部用户头像 ∪ 全部页面当前版本与所有历史版本正文里出现的 `/api/files/<key>`；回收站里的页面在彻底删除前同样计入，它的图一律保留。
- 内容桶（`ciki-content`）：引用集 = 全部 `pages.content_hash` ∪ 全部 `page_revisions.content_hash`（含回收站页面与其版本）；没有指针指向的正文对象才会被删（写路径失败留下的孤儿就是这样收走的）。

两个桶各自只被自己那一类清理扫描/删除，互不越界；锁与 20 天幂等闸也按 kind 各管各的。

第一次启用内容 GC 前，管理员可以在「系统管理 → 数据库维护」先跑一次 dry run（`POST /api/admin/r2-cleanup`，`{"kind":"content","dryRun":true}`）：响应里的 `prunable` / `prunableBytes` 是「会被删的对象数与字节数」，`deleted` 只是本轮受 200 上限约束的将删数；确认数量符合预期（例如迁移中途失败留下的孤儿）再实跑。

触发方式只有一个开关——GitHub Secret `WAKER_SIGNING_KEY` 的取值（三态）：

- **没配（默认）**：走 Worker 内置 Cron Trigger，`worker/wrangler.toml` 里是 `0 17 1 * *`（UTC）。Cloudflare Cron 只按 UTC 解释，而「`Asia/Shanghai` 时区每月 1 日凌晨」落在 UTC 上个月最后一天、5 字段 cron 表达不了，所以取 UTC 每月 1 日 17:00 = **`Asia/Shanghai` 每月 2 日 01:00**（凌晨低峰、每月一次）。waker 触发口此时 fail closed（回 `500 signing_key_missing`）。
- **配了**：由 waker 平台回调驱动，内置 Cron 的 `scheduled()` 检测到已配真 key 会自行让路（`[triggers]` 配置保留，靠取值让路）。在 waker 管理面一次性静态注册一项：

| 项       | 值                                         |
| -------- | ------------------------------------------ |
| 回调 URL | `https://<你的站点域名>/_waker/execute`    |
| 任务名   | `monthly-r2-orphan-cleanup`                |
| cron     | `0 1 1 * *`                                |
| 时区     | `Asia/Shanghai`（= 每月 1 日 01:00，低峰） |

- **设为 `false`（显式关闭）**：把 GitHub Secret `WAKER_SIGNING_KEY` 的值改成 `false` 并重新部署，自动清理整体停掉——内置 Cron 与 waker 回调都不再跑（`scheduled()` 只记一条「显式关闭」日志就跳过，回调口回 `500 signing_key_missing`）。这是保留值、大小写敏感，只认小写 `false`；关的只是自动触发，「系统管理 → 数据库维护」的手动清理与 `POST /api/admin/r2-cleanup` 照旧可用。**记得同时去 waker 管理面停掉 `monthly-r2-orphan-cleanup` 任务**，否则每月会收到一次注定失败的回调。

删掉 `WAKER_SIGNING_KEY` 重新部署即回到内置 Cron，改成 `false` 则是关闭自动清理。每轮结束都会往 D1 的 `{prefix}r2_cleanup_runs` 写一行日志；距上次真实成功运行不足 20 天的触发会被跳过（并记一行跳过日志），避免两个入口双跑。

验收可以只算不删（管理员会话，没有页面按钮）：

```bash
curl -X POST https://<你的站点域名>/api/admin/r2-cleanup \
  -H 'content-type: application/json' \
  -H 'cookie: <你的会话 Cookie>' \
  -d '{"dryRun": true}'
```

「系统管理 → 数据库维护」页显示最近一轮真实运行的一行摘要（运行时间、扫描数、引用数、删除数、未满 30 天跳过数、失败数）。
