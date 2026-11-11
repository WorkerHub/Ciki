# worker/src/waker —— waker 客户端 SDK（**外部源码拷贝，勿改**）

本目录是 waker 官方客户端 SDK 的**逐字拷贝**，不是 ciki 自己的实现：

| 项 | 值 |
| --- | --- |
| 来源 | <https://github.com/WorkerHub/waker> 的 `client/src/` |
| 版本 | `@workerhub/waker-client` 2.0.0 |
| 接入方式 | SDK README 指定的「把 `client/src` 拷进下游项目（如 `src/waker/`）」 |
| 依赖 | 唯一 peer 是 `hono`，不 import 平台内部任何模块 |

七个文件与上游一一对应：`protocol.ts` / `verify.ts` / `ledger.ts` / `receiver.ts` / `client.ts` / `modes.ts` / `index.ts`。

**规则**

1. 本目录内任何 `.ts` 文件都**不得手改**：需要修 SDK 就回 waker 仓库改、发版，再整目录重新拷
   （`cp client/src/*.ts ciki/worker/src/waker/`），并把上面表格的版本一起更新。
2. 本目录在 `biome.json` 的 `files.includes` 里被显式排除（`!worker/src/waker/**`）：
   上游风格是单引号 + 分号，与本仓 formatter 相反，参与格式化就不再是逐字拷贝。
3. ciki 只用它的 receiver（`createWakerReceiver`）与 D1 幂等账本（`createD1ExecutionLedger`）；
   业务接线在 `src/routes/waker.ts` + `src/core/r2-cleanup.ts`。
   `mountWakerReceiver` / `createWakerClient*` / `syncManifest` / `resolveWakerMode` **不调用**——
   规格只认 `WAKER_SIGNING_KEY` 的取值（未配置 / `false` 显式关闭 / 已配置三态，见
   `src/core/waker-gate.ts`），不设 `WAKER_MODE`。
