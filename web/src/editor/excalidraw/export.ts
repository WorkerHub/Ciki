if (typeof window !== "undefined") {
  ;(
    window as unknown as { EXCALIDRAW_ASSET_PATH: string }
  ).EXCALIDRAW_ASSET_PATH = "/"
}

export interface RenderSceneOptions {
  elements: readonly any[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown> | null
}

/**
 * 懒加载 Excalidraw 浏览器端导出能力，按 2x（exportScale: 2, exportBackground: true）渲染出 PNG Blob。
 * 仅当画布缺少 previewKey 时动态触发加载，不污染普通正文首屏体积。
 */
export async function exportSceneToBlob(
  scene: RenderSceneOptions
): Promise<Blob> {
  const { exportToBlob } = await import("@excalidraw/excalidraw")
  return exportToBlob({
    elements: scene.elements,
    appState: {
      ...(scene.appState || {}),
      exportScale: 2,
      exportBackground: true
    },
    files: (scene.files as any) || null,
    mimeType: "image/png"
  })
}
