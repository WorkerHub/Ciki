// 最小 Service Worker（规格第 4 项）：仅为满足 Android Chrome 的可安装性。
// fetch 直通不缓存——部署更新后用户不会被旧版本卡住，也不做离线缓存。
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request))
})
