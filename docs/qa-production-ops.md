# 生产核对与数据清理口径

涉及生产 D1/R2 的只读核对、凭证铸造与测后数据清理。直调 Cloudflare API 的通用方法与红线（令牌来源、账号/桶 id、`gh api --input`、wrangler OAuth 复用等）见 Demo 仓库 `docs/cloudflare-api-access.md`；r2-cleanup 的机制与引用集定义见本仓库 README「月度 R2 清理」，本文只记 README 没写的实操口径。

## 一、生产凭证与会话

- `/api/admin/*` 只认管理员会话 Cookie：借真人管理员的 `user_id` 铸一行 `sessions`，用完 `DELETE` 该行即吊销。
- 凭证铸造的最小写入集（须被明确授权后执行）：
  1. `users`：`.test` 保留域邮箱、`approved` + `active`；密码哈希格式 `saltHex:hashHex` = PBKDF2-SHA256、10 万次、32B 盐 32B 输出（占位值即可，见 `worker/src/core/auth.ts` 注释）。
  2. `api_tokens`：`randomToken` 32B base64url、`token_hash` = sha256 hex；无 scope 行 = 不限空间。
  3. `sessions`：`id` uuid、`token_hash`、`expires_at` unix 秒。
  4. `import_tokens`（剪藏导入用）。
- 吊销用 `DELETE /api/me/tokens/:id`（即时生效，同一令牌读回立刻 401）。
- 测试账号终局拆除顺序：吊销令牌 → 删 sessions → 删 import_tokens → 删 users → R2 按 key 删对象 → 逐项终态核对。

## 二、直查生产数据

- D1：`wrangler d1 execute <db> --remote --command/--file`；先 `--json` 小查询验证口径再放大。设置表是 `ciki_system_settings`。
- R2 LIST（SAPI）：`GET /accounts/{account_id}/r2/buckets/{bucket}/objects`（可带 `per_page`，翻页跟随响应里的令牌即可）。响应形态的坑：`result` 是**裸对象数组**（不是 `{objects: [...]}`）；翻页令牌在 `result_info` 里；对象时间字段是 `last_modified`（不是 `uploaded`）。解析错形状会误判「桶为空」。
- 生产读回的 ETag 是弱 `W/"…"`（R2 SaaS 特性），与本地 miniflare 的强 ETag 不同，不是缺陷。
- 对象生命周期用带会话的 `GET /api/files/<key>` 看 200/404；本地 R2 对象在 `<persist-to>/v3/r2/<bucket>/blobs`。

## 三、r2-cleanup 实操

- `POST /api/admin/r2-cleanup {"kind":"images"|"content","dryRun":true}`：只算不删；多返回 `prunable` / `prunableBytes`，但**dry run 也会写一行 `r2_cleanup_runs` 审计**。实测一轮约 2 分钟，curl 超时给 ≥600s。
- 客户端中途断开：不落审计行，且按 kind 的分布式锁（`system_settings` key = `r2_cleanup_lock:<kind>`，TTL 30 分钟）会泄漏到自然过期——**不要手工改锁行**，等 TTL。
- 真实清理只删「不在引用集、且上传超过 30 天」的对象；自动入口还有 20 天幂等闸（dry run 不受限）。
- 验收比对纪律：上传前后对桶做全量 LIST 快照逐 key 比对；删除只用按 key 精确 DELETE，严禁批量接口。
- 孤儿 hunt：按上传时间窗筛候选 → 减去已知引用 key（页面正文 `/api/files/` 引用、`users.avatar_key`、`pages`/`page_revisions` 的 `content_hash`）→ 逐 key 精确删。内容桶 `content/<sha256>` 是内容寻址，可能被多个页面共享，**禁按 hash 删**。

## 四、测后清理顺序

1. 用 write 令牌软删/永久删测试页：`DELETE /api/write/pages/:id`（软删）；`DELETE /api/pages/:id/permanent`（永久删，级联 revisions/comments/FTS）。
2. **再**吊销令牌（`DELETE /api/me/tokens/:id`）——顺序反了后续删除全 401/409。
3. R2 不随页面删除即时清理（自动清理是月度 waker + 30 天龄门槛）：测试传的 assets 要从页面正文与历史 revision blob（内容桶对象是 gzip 的 TipTap doc JSON，哈希是 gzip 前字节）提取 key 逐个删。
4. `notifications` 无外键，须显式删 recipient/actor 行。
5. 兜底：若测试用户/会话已先删导致 API 不可用，用 D1 按 QA id 范围 + 归属过滤（`created_by`/`author_id`/`editor_id` IN QA 用户）执行同口径四表级联删除。

## 五、版本与「修复是否已在生产」

- 部署版本用 `GET /api/public` 的 `version`；本地只认 env `APP_VERSION`（页脚构建串取自 `build-info.json`）。
- Ciki 的 PR 走 squash 合并：分支头**不是**合并提交的祖先（`merge-base --is-ancestor` 为否），但改动内容已进合并提交。判断「某提交是否进了被测版本」必须同时查祖先关系与文件内容（`git show`/grep 源码），只看祖先关系会误报「未包含」——Demo 仓库 `docs/qa-fix-verification.md` 的祖先检查口径在这里不够用。
- 页脚版本串 `v<版本>-<git 提交数>-<短哈希>`：提交数不是构建次数，同一提交重建数值不变；但内嵌 `builtAt` 使每次构建的 JS 内容哈希必变。生产 `index.html` 有边缘缓存，复抓要绕缓存；比对特征串用生产入口 JS 里的实际 chunk 名，不要拿本地构建的 chunk 名去匹配。

## 六、waker 在册核验（无凭据时）

- 两表互证：`waker_executions`（执行账本，`response_json` 存回调响应）+ `r2_cleanup_runs`（`trigger` = waker/manual、`dry_run`、计数）。
- waker 平台公开面只有 `/healthz`；`GET /v1/jobs` 需项目令牌（明文只在创建者手上）、`/api/*` 需 waker 管理员 JWT。无凭据时「在册」只能给间接证据链：账本有成功执行 + `WAKER_SIGNING_KEY` 配置态 + 无注销变更。
- 仓库历史始于 2026-11-14（`8d4e20c` init version），更早的部署行为只能靠生产数据推断（早期 waker 回调只跑 images，内容 GC 接入更晚——早期无 content 行不是缺陷）。
