import i18n from "@/i18n"

export interface FormatAgentAuthorOptions {
  name: string
  isAgent?: boolean
  ownerName?: string | null
}

export interface FormatAgentAuthorResult {
  displayName: string
  showAgentBadge: boolean
}

/**
 * 规格 §2 Owner 显形：
 * - 作者为 agent 且 ownerName 非空：名字呈现为「{agent 名}（{ownerName} 的 Agent）」；
 *   已有的「Agent」小标记与此形态二选一呈现、不叠加；
 * - ownerName 为 null / 空时回落为仅「Agent」标记；
 * - 非 agent：显示原名，不带 Agent 标记。
 */
export function formatAgentAuthor({
  name,
  isAgent,
  ownerName
}: FormatAgentAuthorOptions): FormatAgentAuthorResult {
  const trimmedOwner = ownerName?.trim()
  if (isAgent && trimmedOwner) {
    const isEn = (i18n.language ?? "").toLowerCase().startsWith("en")
    const formatted = isEn
      ? `${name} (${trimmedOwner}'s Agent)`
      : `${name}（${trimmedOwner} 的 Agent）`
    return {
      displayName: formatted,
      showAgentBadge: false
    }
  }

  return {
    displayName: name,
    showAgentBadge: Boolean(isAgent)
  }
}
