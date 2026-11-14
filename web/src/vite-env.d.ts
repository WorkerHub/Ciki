/// <reference types="vite/client" />

/**
 * 构建期注入的应用版本号（由 web/vite.config.ts 的 define 静态替换）：
 * `git describe --tags --always --dirty`，CI 下追加 `+build.<run_number>`。
 * 源码里不得手写版本号，一律引用这个常量（页脚、关于页）。
 */
declare const __APP_VERSION__: string

/** 构建时刻（ISO 8601，UTC），同样由 vite.config.ts 注入。 */
declare const __APP_BUILD_TIME__: string
