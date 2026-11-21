import "./index.css"
import "./i18n"
import { createRoot } from "react-dom/client"
import { App } from "./App"

const root = document.getElementById("root")
if (!root) throw new Error("缺少 #root 挂载点")

createRoot(root).render(<App />)

// PWA（规格第 4 项）：仅生产环境注册最小 Service Worker，fetch 直通不缓存。
// 注册失败不影响站点运行（无 SW 时浏览器仍按普通网页工作）。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // 忽略：注册失败不阻塞首屏
  })
}
