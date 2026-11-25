import { type CommandProps, isNodeSelection } from "@tiptap/core"

/**
 * 块级节点安全插入：当当前选区为块节点选中态（NodeSelection）时，
 * 将新块插入到该节点之后（state.selection.to），防止原节点被覆盖替换；
 * 普通文本选区或折叠光标维持原生的替换/插入逻辑。
 */
export function insertBlockAfterNodeSelection(
  { commands, state }: CommandProps,
  content: Parameters<typeof commands.insertContent>[0]
): boolean {
  if (isNodeSelection(state.selection)) {
    return commands.insertContentAt(state.selection.to, content)
  }
  return commands.insertContent(content)
}
