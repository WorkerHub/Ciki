export interface HtmlEmbedNodeAttrs {
  /** R2 文件 key，形如 "embeds/<uuid>.html" */
  key: string
  /** 展示高度（像素），默认 480，保存/解析 clamp 200–2000 */
  height: number
  /** 原始文件名 */
  name: string
}
