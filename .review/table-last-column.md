# 编辑态多列表格末列右边线拖不动：实测说明

结论：末列的手柄本身正常（hover 出 `resize-cursor` + `.column-resize-handle`），拖不动是因为
`.wiki-content table { max-width: 100% }` 把「总宽 = 各列之和」的表格压回正文宽——列宽被改了，
总宽涨不上去，浏览器只能从其他列匀，右边线因此不动。改动是 `web/src/index.css` 的一条规则：
带列宽的表格放开 `max-width`，超出正文宽交给已有的 `.tableWrapper` 横滚。

## 复跑方式

```bash
pnpm build:web
node .review/table-width.mjs web/dist 8899 .review
```

脚本自带同源 mock（`.review/mock-server.mjs`）与一页四张表的正文，用真 Chrome（headless）+
真实鼠标事件（`mousePressed → mouseMoved×6 → mouseReleased`）拖末列右边线，数字全部读 DOM 几何：
① 当前构建 → ② 保存后进阅读态 → ③ 注入旧规则（`max-width: 100% !important`）复现修前。

环境：视口 1280×1000，编辑页正文宽 951px（阅读页 1001px，无工具条与留白差）。

## 修前 / 修后

| 场景                                    | 修前                                                             | 修后                                                                               |
| --------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ① 317×3（总宽=正文宽 951）              | 拖末列 +120：模型列宽 317→557，渲染仍 950.8（255.5/255.5/438.9） | 拖末列 +120：总宽 1071、列 316.7/316.7/436.6、`scrollWidth 1071 > clientWidth 951` |
| ② 120×3（360，窄于正文宽）              | 拖 +120 → 480                                                    | 拖 +120 → 480（列 119.8/119.8/239.4）                                              |
| ③ 400×3（存宽 1200 > 正文宽，等同粘贴） | 渲染 950.8（316.6×3，比例被挤压）                                | 渲染 1200（399.7×3）+ 横滚；再拖末列 +60 → 1260（399.7/399.7/459.7）               |
| ④ 单列表格                              | 950.8 满宽、无横滚                                               | 950.8 满宽、无横滚（`max-width` 仍 100%）                                          |

保存回执（mock 收到的 `PUT /api/pages/1` 里的 `contentJson` 列宽）：

- ① `[[317],[317],[437]]`　② `[[120],[120],[240]]`　③ `[[400],[400],[460]]`　④ 单列表格为 `null`（恒满宽的口径没变）

阅读态（`/p/1`）按同一宽度渲染：① 1071（316.7/316.7/436.6）　② 480　③ 1260　④ 1000.8 满宽。

截图：`table-width-before-edit.png`（旧规则，存宽 1071 的表格被压回 951）、
`table-width-after-edit.png`（新规则，1071 带横滚条）、`table-width-after-read.png`（读态同宽）。
原始数值见 `table-width-measurements.json`。

## 逐条对应验收

- ① 总宽已达正文宽的多列表格：末列 +120 生效 → 保存的 `colwidth` 与拖动结果一致 → 读态同宽。
- ② 窄于正文宽的多列表格：同样可拖（120×3 → 480）。
- ③ 带列宽的表格（粘贴口径）：比例保真（400/400/400 如实渲染，不再被挤压），末列可拖。
- ④ 单列表格仍恒满宽，保存后 `contentJson` 里没有 `colwidth`。
- 中间列拖动、粘贴列宽换算（`web/src/lib/table-columns.ts`）、单列表格特例均未改。

## 门禁

```
pnpm --filter web test     # 67 files / 732 tests 全绿（含 table.test.tsx 新增 4 例）
pnpm --filter worker test  # Node 48/576、workerd 5/18（worker 未改，跑一遍确认没连带）
pnpm typecheck             # web + worker
pnpm lint                  # biome lint .
pnpm format:check          # biome format .
```

## 已知边界（prosemirror-tables 的原生行为，本单不改）

从没设过列宽的表格，首拖只给被拖那一列落 `colwidth`，表格此时只有 `min-width`、总宽仍跟内容走：
末列在表格未达正文宽前可自由拖，到正文宽后不再外扩。把各条竖线各拖一次后列宽齐了，总宽变成
列宽之和，就能拖出正文宽（实测 316.6×3 的表连拖三条边线，第三次落下后 `table.style.width = 990px`）。
