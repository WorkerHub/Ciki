# 本地 QA 环境与真跑口径

Ciki 专属的本地实例起法与真浏览器验收口径。跨项目通用的技法（Playwright 等待与拦截、代理、Radix 浮层、断言纪律、线上产物排查、`gh api` 坑）先读 Demo 仓库的 `docs/qa-browser-testing.md` 与 `docs/qa-fix-verification.md`，这里只记 Ciki 特有的部分。

## 一、起一个可测实例

- 在 `/tmp` 建真 worktree 检出待测 commit：clone 目录只读，且 prebuild 会写 `build-info.json`，不要在其中构建。
- `pnpm install --frozen-lockfile` → 根脚本 `pnpm build:web`。直接 `pnpm --filter web build` 会报 TS2307（`build-info.json` 由根 prebuild 生成）。
- `worker/.dev.vars`：`ENCRYPTION_KEY` 用合法 32 字节 base64（写错则接口全返 Server misconfigured）、`SETUP_SECRET`；按需加 `TABLE_PREFIX`、`APP_VERSION=v<semver>-<n>-<sha>`（本地版本自证口只认 env）。
- 端口先查再起：`lsof -ti :PORT -sTCP:LISTEN`。**释放端口必须带 `-sTCP:LISTEN`**——不带时 `lsof -ti :PORT` 会匹配与该端口有 TCP 关系的所有进程：被控 Chrome 的 keepalive 连接被杀就丢掉 CDP 虚拟认证器（passkey 直接锁号），node 自己的 CLOSE_WAIT socket 被杀则出现「QA 脚本无任何输出地 SIGKILL 自己」。wrangler/pnpm 层用 `pkill -f` 按端口模式精确匹配。8787 常被历史 workerd 占用。
- `wrangler dev --port <空闲> --persist-to /tmp/<名>/state`：每个实例独立 state 目录；默认的 `.wrangler/state` 是共享污染库，别用。
- 初始化：`POST /api/setup`（`X-Setup-Secret` 头）是**唯一的迁移入口且幂等**，boot 不会自动迁移；随后第一个 `POST /api/auth/register` 用户即管理员。
- worker 托管 `web/dist` 并带 SPA 回退：直接访问 worker 端口就能测整页刷新，不需要 vite dev。
- 运行中不要删 `worker/.wrangler`（会报 middleware-loader 解析失败）；换实例先杀 workerd 再删。
- `wrangler d1 execute --local` 用占位库名即可直改本地 D1（设置表 `ciki_system_settings`）；dev 在跑时别对同一 sqlite 并发写。
- 页脚版本串取自 `build-info.json`（`v<版本>-<git 提交数>-<短哈希>`，提交数不是构建次数）。它内嵌 `builtAt`，所以**每次构建的 JS 内容哈希都会变**：跨重建做像素对比时页脚与产物差异属预期，要排除。

## 二、造数与登录态

- 注册页由 `emailConfigured` 门控（未配 SMTP 整页「暂不可用」），且后端也拦：`POST /api/auth/register` 与发码端点在未配 SMTP 时 503 `EMAIL_NOT_CONFIGURED`（不写计数）。要让注册可用：播种 `ciki_system_settings` 的 `email_provider=smtp` + `smtp_config`（口令按 `ENCRYPTION_KEY` AES-GCM 加密落库，AAD 为 `ciki:smtp:password`），或直接写 D1 造用户。
- 建页 `POST /api/pages`：`title` + `contentJson`（TipTap doc JSON 字符串）+ `contentHtml` + `contentText`。
- 无改动保存是 no-op：正文哈希 + HTML + 纯文本全等且标题相同时不写库、不涨 `updated_at`、不产新版本（`worker/src/core/page-write.ts` 的 `bodyUnchanged`；改名例外，只当元数据改写）。造「已更新」状态要用真实改动的内容，纯 UI 空保存造不出。
- 单页 JSON 必须 `GET /api/pages/:id?format=json`：默认只回 `html`/`text`/`md`，`contentJson` 缺失（`JSON.parse(undefined)` 会抛）。
- 登录限流以 D1 计数表为权威：IP 10 次 / 5 分钟返 429；同账号失败 5 次即 `ACCOUNT_LOCKED`（900 秒窗口）。批量场景别打登录接口，用 `context.addCookies` 注入 `ciki_session`（`domain: "127.0.0.1"`、`path: "/"`、`secure: false`），再用 `GET /api/me` 自证。
- Playwright context 必须 `serviceWorkers: "block"`，否则 `sw.js` 先注册、请求从 SW 发出绕过 `page.route`。
- 写接口只认 Bearer 令牌：`POST /api/me/tokens {"kind":"write"}`。页面路由是 `/p/<id>`（不是 `/pages/<id>`）；`/` 会链式重定向到第一页详情，指针操作前先等 URL 稳定（`waitForURL /p/\d+/`），否则拖动会落成点击导航。
- 头像：选文件后还要点底部「保存」才发 `POST /api/me/avatar`。输出尺寸规则在 `web/src/lib/avatar.ts`（选区 ≥512 缩到 512×512，小图不放大）。

## 三、主题注入与自证

- `localStorage["ciki-theme"]` 是 zustand persist 的原样快照：`{state:{theme,style,migratedAt},version:0}`。`theme` 是明暗三档（`auto`/`light`/`dark`）、`style` 是 `nova`/`paper`——**两个字段极易写反**。
- 写错不再崩：`onRehydrateStorage` 会把非法的 `theme`/`style` 降级为 `auto`/`nova`（#279）。因此「注入成功」不等于「主题生效」，每次截图都要在量测里记 `bodyBg` + `data-theme` 自证（paper 浅色页底 `rgb(247,244,238)`，nova 白底）。
- 注入用函数式 `page.addInitScript(fn, arg)` 最可靠。
- 设置页的主题与语言都是「选择 + 保存」两段式：ToggleGroupItem 渲染成 `role="radio"`（不是 button）；点击已选中的 radio 会 `onValueChange("")`，保存按钮永不 enable——点击前先查 `aria-checked`。页面里有两个「保存」（外观卡 + 语言卡），`hasText('保存')` 要核对点的是哪一个。顶栏亮暗循环按钮的 `aria-label` 形如「主题：浅色，点击切换」，循环顺序 `auto → light → dark`，据 `data-mode` 判当前态。
- 分段控件选中态是浅灰填充（`#f5f5f5`）、未选中是白底描边，看截图容易看反：以 DOM `aria-checked` 为准，或用已知选中项定标。
- i18n 词条按语言不对称：`zh` 的语言分区 aria-label 是「界面语言」，`en` 是「Language」。按语言取词条前先查 `web/src/locales/*.json`。

## 四、截图与 DOM 坑

- AppShell 是内滚动布局：`fullPage` 截图仍只有视口高度，拍下方卡片先 `scrollIntoViewIfNeeded()`。
- 阅读页 `/p/<id>` 同样是内滚动容器（`document` 不滚）：横滚检查要同时量 `documentElement` 与内滚动容器两层。
- 表格撑宽造法：阅读视图单元格是 `white-space: break-spaces` + `overflow-wrap: break-word`，纯文本与内联 code 都能任意断行、撑不破表格；要造表格横滚得在单元格里嵌 codeBlock 长代码行（`pre` 不可断行）把 min-content 撑破。
- 编辑态像素对比前先 `page.locator(".ProseMirror p").first().click()` 固定 selection：加载后不点击时，工具条段落样式标签会在「正文 / 标题 2」间随机（TipTap 初始化时序内 selection 未定），否则 diff 会多出工具条假差异。
- TipTap 的 React NodeView 会在节点 DOM 外再包一层挂载 div：`figure[data-image-block]`、`img[data-type=excalidraw]`、`[data-html-embed-block]` 往往不是 `.ProseMirror` 的直接子元素，取 blocks 要 `querySelector` 向下找；PM view 内省（`pmViewDesc.view`）不可靠，首跑会抛 `null.doc`。选中态断言用 `.ProseMirror-selectednode`。
- shadcn 的 `CardTitle` 是 `div` 不是 heading，`getByRole('heading')` 会超时，改用输入框 `aria-label` 定位。
- 画布真实落盘走 ExcalidrawModal 的「保存」（上传场景 JSON + 预览 PNG）：`excalidrawAPI` 未就绪时点击是 no-op，脚本要重试等待 `img[data-scene-key]` 出现；embed key 可从卡片文本用 `/embeds\/[0-9a-f-]{36}\.html/` 提取。
- HTML embed 的 iframe 是 border-box + 上下各 1px 边框：`style` 高度 = 内容高时，内层视口 = 内容高 − 2，于是内层文档恒可滚 2px、内容末 2 行被边框裁掉。判定「自动贴合」用尾差 = 外框 borderBox 高 − 内层内容高（`max(de.offsetHeight, body.offsetHeight, body.scrollHeight)`），尾差 0 即贴合；这 2px 与内容高无关，不是回归。
- embed 的 `sandbox="allow-scripts"`（opaque origin）读站内 localStorage 必抛 sandboxed 错误，属设计使然；CSP 与 nosniff 在 `worker/src/routes/files.ts` 下发。
- 本地 R2 对象在 `<persist-to>/v3/r2/<bucket>/blobs`；对象生命周期用带会话的 `GET /api/files/<key>` 看 200/404。
- 页面树拖拽落点契约：拖到目标行上偏下 = 插入该行之后（movingDown 语义），期望值按此计算。
- 评论区：断言列表文案别匹配渲染后 Markdown（粗体被吃、换行重组），造数注入唯一标记串（如 `QA47-TOP`）匹配；composer 用 `[data-comment-composer]` 按「发表/回复/保存」按钮过滤，「取消」只在编辑/回复场景出现在 `[data-comment-id]` 条目内；预览开关用 `aria-pressed` 判态（发表后 disabled=true 是空正文规则属正常；死锁特征 = aria-pressed=true 且预览区仍在）。
- 像素级验收：聚焦环/裁剪类用元素外缘 ~6px 条带两态逐字节比较，另拍三连（未聚焦→聚焦→未聚焦）验证截图确定性后才可信；PNG 判色可 `page.evaluate` + Image/canvas 解码；内滚动应用截图用 viewport clip（坐标取 getBoundingClientRect 视口相对值，截图前后不得滚动）；对齐参照选贯穿列全宽的元素（如 Separator），自适应宽度的 h1 右缘不可作参照；ESM 脚本依赖从脚本所在目录解析，复用别处 node_modules 用 `ln -sfn` 链接。

## 五、升级验收（老代码 + 同库换 worker）

- 路径：`/tmp` 老代码 worktree（含 `node_modules`/`web/dist`/`.dev.vars`）起 worker + 共享同一 D1 state 目录 → 用老版本造存量 → 停老 worker（浏览器不动，CDP 虚拟认证器跨升级存活）→ 在同目录起 main 的 worker → `POST /api/setup`。
- 迁移唯一入口是 `POST /api/setup`（幂等），boot 不自动迁移。2FA 回填规则：Passkey 按 `created_at ASC, id ASC` 命名「Passkey 1..N」，启用了 TOTP 的命名「TOTP」。

## 六、断言与请求窗口

- 「不发请求」类断言用窗口计数：页面 `request` 事件逐条落 `metrics.json`，断言窗口内匹配方法 + 路径的请求数为 0。
- 状态断言用前后相等，不要假设初值为 `null`（复跑会假失败）。
- 真断网（CDP offline）下 `fetch` 立即拒绝、乐观态毫秒级回滚，采样抓不到：要证实乐观呈现用 `context.route` 延迟 ~800ms 再 abort。
- 定向断网只 abort 目标请求、其余 `continue`；`evaluate` 里的 `fetch` 加 `cache: "no-store"`。
- 禁用按钮的 `click()` 会挂起到 enabled（默认 30s）：`Promise.all([waitForResponse, click])` 里前者超时后 click 仍在后台跨步骤执行——click 前先断言 enabled，并给显式短 timeout。
- 用 `expect.poll` / `waitFor` 代替固定 sleep（读按钮态这类 200ms 采样会踩竞态）。apiLog/results 等落盘放 `main().finally()`，FATAL 也不丢。
- 服务端写回用 D1 直查 `updated_at` 与请求时刻交叉验证。
- 头像类验收：状态时间线（每步前后取 `avatarUrl` 比对字符串相等）+ 请求窗口计数。测试图用 PIL 造四色象限非方形大图；「解码失败」文件用伪随机字节 + PNG 魔数（过类型校验、`createImageBitmap` 必失败），先用 PIL 确认不可解码。
- Radix 滑杆用 `[role="slider"]`；头像裁剪的滑杆值是反向映射（`sliderValue = maxCropSize + minCropSize - cropArea.size`），所以 `End` = 最小选区、`Home` = 最大选区。拖动用 `page.mouse` 从 crop-box 中心分步移动，断相对位移与画布钳制。
- 2FA 的 TOTP 有防重放（`auth_challenges` 的 `totp_used`，key = `userId:code`）：同一 30s 时间步里启用码与登录码相同会 400，QA 要等下一时间步（`msToNext + 500ms`）再生成登录码。
- puppeteer 脚本结束不 `close()` 浏览器会让 Chrome 持有 stdio 管道：`tee` 不退出、bash 调用挂到超时。脚本尾部加 `await browser.close()`。
