# Passkey/TOTP 加名字 · Jim 真跑验收报告

- **结论：签收（21/21 PASS，无失败项，无放水）**
- 被测对象：后端单 #215（commit `5a25624`）+ 前端单 #216（commit `94bb22f`）
- 验收日期：2026-11-25
- 测试环境：wrangler dev @ localhost:8790（D1 本地持久化）；QA 账号 qa-admin@ciki-qa.test；Chrome 虚拟认证器（CDP addVirtualAuthenticator，每凭证一 VA）；界面语言 zh
- 测法说明：所有 UI 项经真实浏览器操作（真实页面 fetch / WebAuthn / CDP 虚拟认证器断言），API 项经页内 fetch 发真实请求；口径 3 用老代码 worktree（e41b65a）造存量后同库换新代码重启
- 证据留存：原始日志在 /tmp/ciki-qa-tools/phase1-last.log、phase2-last.log；本报告为逐项转录。未改动任何产品代码

---

## 口径 1：添加 Passkey 填名 + 默认名 — ✅ PASS（3 项）

**标准**（指挥官定版原文）：添加 Passkey 时填名「我的 YubiKey」：注册成功，列表出现该名 + 创建时间；再加一个不填名：默认名「Passkey N」正确。

| 子项 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 1a 填名注册 | 设置页「添加 Passkey」对话框输入「我的 YubiKey」→ 真实 WebAuthn 创建 → 观察列表 + GET /api/me | PASS | 列表行=`我的 YubiKey · 创建于 2026-11-25 15:33 · 最近使用：未使用 · 改名/删除`；/api/me passkeys[0].name=我的 YubiKey；verify 请求 body 含 name=我的 YubiKey |
| 1b 不填名默认名 | 已有 1 个凭证时留空再注册 | PASS | 新凭证名=`Passkey 2`（N 递增正确）；passkeys=[我的 YubiKey, Passkey 2] |
| 附 新凭证可登录 | 退出 → 登录页单方式形态「使用 Passkey 验证」按钮 → VA 断言 | PASS | 登录成功 URL=/ |

## 口径 2：并存区分 / 改名 / 单删 / 全部移除 — ✅ PASS（3 项）

**标准**：两个 Passkey 并存时可按名字区分；对其中一个改名成功、刷新保持；删掉其中一个（密码确认），另一个不受影响；「全部移除」仍可用。

| 子项 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 2b 改名+刷新保持 | 行内「改名」→ 对话框回填旧名 → 改「我的旧钥匙」→ reload | PASS | reload 后列表保持=[我的 YubiKey, 我的旧钥匙, 边界·trim, API改] |
| 2c 单删不影响其它 | 「删除」→ 密码确认对话框 → 确认 | PASS | 删除前 4 个 → 删除后=[我的 YubiKey, 我的旧钥匙, API改]，其余原样 |
| 2d 全部移除仍可用 | 「全部移除」→ 密码确认；TOTP 不受影响可继续登录 | PASS | 移除后 passkeys=[]；totpEnabled=true、totpName=我的验证器 |

## 口径 3：存量升级 — ✅ PASS（5 项）

**标准**：存量（升级前已注册）的 Passkey 在升级后有默认名、不丢凭证，仍可正常登录。

测法：老代码 worktree（e41b65a）起 worker + 独立 D1 目录 → 老 setup（6 迁移）→ 注册 2 个 Passkey（无 name）+ 启用 TOTP → 老基线核实（老 /api/me twofa 仅 `{totpEnabled,passkeyEnabled,passkeyCount,emailOtpEnabled}` 无名字字段；DB v13 passkey_credentials 无 name 列）→ 停老 worker（浏览器与虚拟认证器跨升级存活）→ 同一 D1 目录起 main worker（5a25624）→ POST /api/setup → 逐项验证。

| 子项 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 3.1 schema_v14 迁移应用 | main boot 后、POST /setup 前查 DB 列；setup 后查 applied 迁移 | PASS | boot 后 setup 前 name 列存在=**false**（启动不自动迁移）；应用迁移=[schema_v1,v9,v10,v11,v12,v13,v14]；name 列存在=true |
| 3.2 Passkey 默认名回填 | 升级后直查 D1（created_at ASC, id ASC） | PASS | DB 回填名=[Passkey 1, Passkey 2]，2 凭证未丢 |
| 3.3 TOTP 默认名回填 | 升级后直查 D1 | PASS | totp_name=TOTP、totp_enabled=1 |
| 3.4 存量 TOTP 仍可登录 | API：/login→requires2fa+tempToken→POST /2fa/verify(method=totp，本地 RFC6238 复算码)→/api/me | PASS | verify HTTP 200；/api/me twofa={totpEnabled:true, totpName:"TOTP", names:[Passkey 1, Passkey 2]} |
| 3.5 存量 Passkey UI 登录 | 退出→密码登录→2FA 步 ToggleGroup[验证器 App/Passkey]→选 Passkey→「使用 Passkey 验证」→**升级前注册的 VA 凭证**断言→设置页 | PASS | 登录成功 URL=/settings；列表行=Passkey 1（最近使用：当日）/ Passkey 2（未使用）；TOTP 名展示=true；截图 p2-3-migrated-light.png |

升级语义补充（实测确认）：迁移唯一入口是 POST /api/setup（幂等，boot 不自动迁移）；回填规则=Passkey 按创建顺序「Passkey 1..N」、启用 TOTP 固定「TOTP」。

## 口径 4：TOTP 填名（URI label）+ 启用登录 + 不填名回退邮箱 — ✅ PASS（3 项）

**标准**：TOTP 重新设置时填名：扫码后验证器条目显示该名（以 otpauth URI label 为准核对），验证码可正常启用与登录；不填名时 label 为邮箱（现状回归）。

| 子项 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 4 TOTP 填名设置+启用 | 设置页 TOTP 对话框填「我的验证器」→ 取 setup 响应 URI → enable 提交 name + RFC6238 复算码 | PASS | uri=otpauth://totp/ciki:我的验证器(URL 编码 %E6%88%91%E7%9A%84%E9%AA%8C%E8%AF%81%E5%99%A8)?issuer=ciki…；enable 请求 name=我的验证器；「两步验证已开启」通知出现 |
| 4b 不填名 label=邮箱 | TOTP 对话框留空提交，核对 setup URI label | PASS | uri=otpauth://totp/ciki:qa-admin%40ciki-qa.test?issuer=ciki…（现状回归符合） |
| 4附 TOTP 验证码登录 | 退出→密码→第二步输入复算码 | PASS | 登录成功 URL=/ |

## 口径 5：设置页 TOTP 已启用状态显示名字 — ✅ PASS（1 项）

**标准**：设置页 TOTP 已启用状态显示名字。

| 子项 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 5 徽标显示 totpName | 填名启用后观察设置页 TOTP 区块徽标 + GET /api/me 交叉验证 | PASS | 徽标文本=我的验证器；/api/me totpName=我的验证器、totpEnabled=true |

## 口径 6：名字边界 — ✅ PASS（4 项）

**标准**：空名走默认、超 50 字符被拒（400）、首尾空格被 trim。

| 子项 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 6-UI 对话框层 trim | 对话框输入带首尾空格名 → 抓 verify 请求 body | PASS | verify 请求 name=边界·trim（已 trim），落库名一致 |
| 6-API 超 50 字符拒 | 页内 fetch POST /api/auth/passkey/register/verify，name=51 字符 | PASS | HTTP 400 `{"error":"Passkey name must be 1-50 characters","code":"INVALID_NAME"}` |
| 6-API 服务端 trim（注册） | 同接口带首尾空格名 | PASS | HTTP 200，落库「API空格」（首尾空格已去） |
| 6-API PATCH 三边界 | PATCH /api/auth/passkey/:credentialId：51 字符 / 空 / 空格 | PASS | 51→400 INVALID_NAME；空→400；空格→200 落库「API改」 |

说明：「空名走默认」由 1b（不填名→Passkey 2）与 6-API 空→400（改名接口空名拒绝，注册接口空名走默认）共同覆盖。

## 口径 7：双主题列表与对话框 — ✅ PASS（2 项）

**标准**：双主题下列表与对话框各验一次主路径。

| 子项 | 测法 | 结果 | 证据 |
|---|---|---|---|
| 7 light | light 主题：列表含命名凭证 + 打开「添加 Passkey」对话框 | PASS | 列表含我的 YubiKey=true；对话框输入框=true；截图 p1-7-light.png |
| 7 dark | html.dark=true 同路径复跑 | PASS | 列表含我的 YubiKey=true；对话框输入框=true；截图 p1-7-dark.png |

---

## 汇总

| 口径 | 子项数 | 结果 |
|---|---|---|
| 1 填名注册+默认名 | 3 | ✅ PASS |
| 2 改名/删除/全部移除 | 3 | ✅ PASS |
| 3 存量升级 | 5 | ✅ PASS |
| 4 TOTP 填名/回退/登录 | 3 | ✅ PASS |
| 5 设置页 TOTP 名 | 1 | ✅ PASS |
| 6 名字边界 | 4 | ✅ PASS |
| 7 双主题 | 2 | ✅ PASS |
| **合计** | **21** | **21/21 PASS，签收** |

无失败项，无放水；未发现需打回缺陷。测试脚本（harness/phase1/phase2.mjs）与原始日志仅存于 /tmp/ciki-qa-tools，未进仓库。
