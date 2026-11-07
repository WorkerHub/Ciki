# ciki

团队成员用的 wiki：把 Confluence 页面原样粘进来，保真渲染（标题、代码块、表格、嵌套/任务列表、图片）。Cloudflare Workers + D1 + R2，一个部署单元同时托管 API 与前端静态资源。

## 技术栈

- `worker/` —— Hono + TypeScript，跑在 Cloudflare Workers；数据在共享 D1，图片在专用 R2 bucket。
- `web/` —— React + Vite + TypeScript；UI 用 shadcn/ui（Nova 风格）+ Kumo + Radix，图标 Lucide、动画 Motion、状态 Zustand、拖拽 dnd-kit、分栏 react-resizable-panels。
- pnpm monorepo；样式 Tailwind CSS v4。

当前是脚手架阶段：只有可运行的骨架与基础设施，业务功能由后续实现单落地。

## 本地开发

```bash
pnpm install
cp worker/.dev.vars.example worker/.dev.vars   # 填入本地 JWT_SECRET / SETUP_SECRET
pnpm dev
```

`pnpm dev` 先构建一次前端（`web/dist` 是 Worker 的静态资源目录），再用 `concurrently` 同时起：

- Worker：`wrangler dev`（默认 <http://localhost:8787>，本地 D1/R2 由 miniflare 模拟，不需要云上账号）
- Web：`vite`（默认 <http://localhost:5173>，`/api` 代理到 8787）

`worker/.dev.vars` 已被 gitignore；真实密钥绝不进仓库。

## 校验

```bash
pnpm lint          # biome lint
pnpm format:check  # biome format
pnpm typecheck     # web + worker
pnpm build         # 前端产物 + worker 类型检查
pnpm test          # worker 单测（vitest）+ web 单测（vitest + jsdom）
pnpm check:deploy  # wrangler deploy --dry-run：校验 wrangler.toml 的绑定与打包
```

## 部署

合并到 `main` 且 CI 通过后，`.github/workflows/deploy.yml` 自动部署 Cloudflare；也可手动触发。**合并与部署关口归用户**，团队不自行合并、不自行部署。

### 组织级配置（WorkerHub，已配置，只引用不新建）

| 名称                    | 类型     | 用途                            |
| ----------------------- | -------- | ------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | secret   | wrangler 部署（含建 R2 bucket） |
| `CLOUDFLARE_ACCOUNT_ID` | secret   | Cloudflare 账户                 |
| `D1_DATABASE_ID`        | secret   | 共享 D1 库 ID                   |
| `D1_DATABASE_NAME`      | variable | 共享 D1 库名（明文，非机密）    |

共享 D1 是既有的 workerhub 库，本项目**不新建数据库**，只在本项目表前缀下的表里读写。

### 仓库级 Secrets（需在本仓库配置）

| Secret         | 用途                                      | 必需 |
| -------------- | ----------------------------------------- | ---- |
| `JWT_SECRET`   | 会话签名密钥（≥32 字节随机串）            | 是   |
| `SETUP_SECRET` | setup / 数据库维护接口的 `X-Setup-Secret` | 是   |

缺任何一把，或值仍是模板里的占位写法（`*_PLACEHOLDER`、`replace-with-*`），部署工作流会**在上传前中止并点名**，不会用空值或占位值顶替。密钥由 `scripts/materialize-secrets.mjs` 写进 `$RUNNER_TEMP/secrets.json`（权限 0600），再经 `wrangler deploy --secrets-file` 上传——真实值不进仓库、不进日志。

### 表前缀 TABLE_PREFIX（三态）

所有表名都经 `worker/src/lib/table-prefix.ts` 的 `getTablePrefix()` 拼出，全仓唯一解析点；除该文件的默认常量外，代码里不写死任何部署前缀或最终表名。

| 配置                                                                                            | 生效前缀 | 表名示例     |
| ----------------------------------------------------------------------------------------------- | -------- | ------------ |
| 不配置（默认）                                                                                  | `ciki_`  | `ciki_pages` |
| 自定义值（如 `wiki`：非空时须以字母或下划线开头，其后只允许字母、数字、下划线，自动补尾部 `_`） | `wiki_`  | `wiki_pages` |
| 显式置空（GitHub Variables 填保留字 `none`；本地 `.dev.vars` 写空值）                           | 无前缀   | `pages`      |

CI 侧规则（`scripts/materialize-secrets.mjs`）：GitHub Variables 的 `TABLE_PREFIX` **未设置或留空 → 注入 `ciki`**（GitHub 无法区分这两者），**`none` → 注入空串**（无前缀），**其他值 → 原样注入**；含非法字符（包括 `2026` 这类前导数字、`ci-ki` 这类带连字符的）时部署中止。补尾部下划线只由运行时做，注入值保持原样。

生效前缀必须在数据库初始化前确定：换前缀等于换一套空表。**部署本身不锁前缀**——它每次按当前变量重写注入值；“生效前缀不可更改”依靠后端单的 setup 与 409 前缀冲突守卫（本骨架尚未实现这些接口）。在那之前请勿在已初始化的库上改 `TABLE_PREFIX`：目前没有任何机制会拦住静默换表。

### R2

图片存在专用 bucket `ciki-assets`（`wrangler.toml` 里绑定名 `R2`——`ASSETS` 已被静态资源占用）。部署工作流会幂等补建该 bucket，只把"已存在"当成成功：

- 组织级 `CLOUDFLARE_API_TOKEN` 需要有 **R2 编辑**权限，否则该步会让本次部署失败（此时尚未部署任何东西）；
- 也可以先在 Cloudflare 控制台（或本地 `wrangler r2 bucket create ciki-assets`）建好，再重跑部署。

### 部署之后：还要初始化一次数据库

部署成功只代表 Worker 上线，**表结构要由管理员再触发一次 setup / 数据库维护迁移才会建**——本骨架不含 setup、迁移与 schema（属后端实现单），现在访问 `/api/setup/*` 只会得到 JSON 404。

部署后的待办：

1. 等后端单交付 setup 面后，由管理员在站点上完成初始化（`SETUP_SECRET` 是那一步的令牌）；
2. 此后每次升级部署，同样由管理员触发一次数据库维护迁移；
3. 初始化完成时须核对回显的生效表前缀与预期一致。

在本骨架单独上线的情况下，站点只有一个占位页与 `/api/health`，不需要也无法初始化数据库。

## 目录结构

```
.github/workflows/   CI（校验）与 Deploy（合并即部署）
scripts/             部署期配置解析（表前缀三态、secrets.json、wrangler.toml 占位符）
web/                 React + Vite 前端（构建产物 web/dist 由 Worker 托管）
worker/              Hono Worker（D1 / R2 / 静态资源三类绑定）
prototype/           Confluence 粘贴验证小样（规格 §5 移植蓝本，非产品代码）
```

`prototype/` 是立项前的验证小样，不参与 lint / 构建 / 测试；产品侧粘贴管线落地并覆盖其断言后，在前端实现单里整体删除。
