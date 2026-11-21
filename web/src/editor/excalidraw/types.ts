export interface ExcalidrawNodeAttrs {
  /** 场景 JSON 在 R2 的 Key，形如 "pages/<uuid>.json" */
  sceneKey: string
  /** 2x 预览图 PNG 在 R2 的 Key，形如 "pages/<uuid>.png" */
  previewKey: string
  /** 画布提取纯文本（搜索与无障碍回退），默认为 "" */
  extractedText: string
  /** 块展示宽度（正整数像素），默认 null 自适应 100% 容器宽度 */
  width: number | null
}
