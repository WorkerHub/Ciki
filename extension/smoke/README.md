# ciki 冒烟验证插件（临时，一次性）

目的：验证「Chrome 插件借浏览器登录态调 Confluence REST 接口整页搬运」这条路在你的培训机构实例上通不通。验证完直接删除即可，不影响正式插件方案。

## 它验什么（全是只读 GET）

1. 当前页的 `pageId` 能否探测到（meta / AJS.params / URL）。
2. 站点级权限申请（`optional_host_permissions` 按需申请你当前站点的域名）。
3. `GET /rest/api/content/{id}?expand=body.storage,version` 是否 200、能否拿到 storage 格式正文（只报字符数，不显示内容）。
4. `GET /rest/api/content/{id}/child/attachment` 附件清单有几张图片。
5. 第一张图片的原图下载是否 200（只报大小与类型）。

候选基址按顺序尝试：域名+contextPath → 域名根 → Atlassian Cloud 的 `/wiki` 前缀，适配自建版与 Cloud 两种部署。

## 它不做什么

- 不向 ciki 或任何第三方发送数据；请求只发往你当前打开的 Confluence 站点本身。
- 不读取、不展示正文文本；面板上只有状态码、字节数、张数、文件名级别的元信息。
- 不写入 Confluence 任何内容。

## 安装（Mac Chrome）

1. 解压 zip，得到 `ciki-extension-smoke` 文件夹（或直接用本目录）。
2. Chrome 打开 `chrome://extensions/`，打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择这个文件夹。
4. 打开任意一篇**带图片**的 Confluence 资料页（保持已登录）。
5. 点工具栏的插件图标 → 「开始验证」→ 若弹出域名授权，点允许。
6. 把面板里的几行结果原样发回给 Muse（全是状态与数字，没有正文内容）。

## 文件

- `manifest.json` — MV3 清单：权限仅 `activeTab`/`scripting`/`storage` + 按需域名权限。
- `popup.html` / `popup.js` — 弹窗与验证逻辑（全部逻辑都在 popup 里，没有后台脚本）。
- `content-probe.js` — pageId/contextPath 探测逻辑的参考副本（popup 以函数注入执行同一份逻辑）。
