/**
 * 仅供 workerd 测试使用的 `node:vm` 替身（别名见 `vitest.workers.config.ts`）。
 *
 * 为什么需要：`@cloudflare/vitest-plugin` 会把它自己那份只含 `runInThisContext`
 * 的 `node:vm` 替身注入到被测模块的解析里；而线上 workerd 的 `node:vm` 是完整的
 * （`Script` / `createContext` 都在）。happy-dom 的 `BrowserWindow` 在模块求值阶段
 * 就 `new Script(...)`，缺构造器会让整条渲染路径连加载都失败。
 *
 * 被测路径（`GlobalWindow`）不碰 VM 上下文，`Script` 只是模块顶层的一个常量；
 * 因此这里给出可构造的占位，并把任何真正的 VM 调用**直接抛错**——将来若有人把
 * 渲染改回 `Window` / `@tiptap/html` 的 VM 上下文路线，用例会立刻红，而不是被
 * 一个假实现糊过去。
 */
class Script {
  readonly code: string
  constructor(code: string) {
    this.code = code
  }
  runInContext(): never {
    throw new Error("node:vm runInContext is unavailable in this test shim")
  }
  runInThisContext(): never {
    throw new Error("node:vm runInThisContext is unavailable in this test shim")
  }
}

function createContext(): never {
  throw new Error("node:vm createContext is unavailable in this test shim")
}

function isContext(): never {
  throw new Error("node:vm isContext is unavailable in this test shim")
}

export { Script, createContext, isContext }
export default { Script, createContext, isContext }
