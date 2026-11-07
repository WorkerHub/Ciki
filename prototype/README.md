# prototype/ — Confluence 粘贴验证小样（参考蓝本，非产品代码）

这是 ciki 立项前由 Muse 与用户共同完成的**粘贴验证小样 v0.4** 的完整源码，2026-11-07 验证收口后原样存入本仓库，供实现粘贴管线时移植参考。它不是脚手架、不要在它上面继续开发产品代码。

## 验证结论（用户真实 Confluence 文档实测）

- 凡进入剪贴板的内容均可保真：多级标题、代码块（含阅读页 SyntaxHighlighter「行号列 + 逐词 code」表格形态）、表格（合并单元格 + colgroup 列宽比例）、嵌套列表、任务列表勾选态；
- 代码块呈现定版：浅色主题 + Lowlight 真语法高亮（GitHub 浅色配色）；
- 图片自动转存不做：Confluence 附件图标黄提示、手动上传替换（规格 §5.7）；
- 已知源侧限制：某些 Confluence 插件表格的表头无法被选中、根本不进剪贴板，粘贴后表头为空，wiki 侧无法恢复（规格 §5 已知限制）。

自动测试：清洗 30/30、TipTap 回读 11/11（`test/` 下两组，移植时断言不得删改放宽）。

## 文件导览

| 文件 | 内容 |
|---|---|
| `src/cleaner.js` | **核心**：Confluence 剪贴板 HTML 清洗管线 `cleanConfluenceHtml()` + 统计分析 `analyzeHtml()`，移植目标是产品的前端粘贴处理 + 服务端二次消毒的规则真源 |
| `src/sample.js` | 两份模拟 Confluence 剪贴板样本（综合样本 + 行号列代码块样本），测试以其为准 |
| `src/main.js` | 小样的 TipTap 2 编辑器接线（扩展集、粘贴拦截插件、Lowlight 配置），产品编辑器接线照此对齐规格 §4 |
| `index.html` | 小样页面与全部样式（含代码块浅色主题与 hljs 配色、表格按内容定宽的 CSS 定版） |
| `test/cleaner.test.mjs` / `test/roundtrip.test.mjs` | 清洗与 TipTap 回读两组 jsdom 测试 |
| `package.json` / `vite.config.js` | 小样依赖（TipTap 2.27.3 全套版本对齐，含 lowlight 3）与单文件打包配置 |

本地跑小样：`pnpm install && npm run build` 后打开 `dist/index.html`；跑测试：`node test/cleaner.test.mjs && node test/roundtrip.test.mjs`。

## 移植完成后

产品侧管线与测试落地后，本目录可整体删除（删除动作放在粘贴管线实现单里，由评审确认产品侧测试已覆盖小样断言后再删）。
