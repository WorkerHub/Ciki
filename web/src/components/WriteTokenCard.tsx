import { ApiTokenCard } from "@/components/ApiTokenCard"

/** 读写接口令牌（二期）：读接口也认它，写接口只认它，与只读令牌各自独立。 */
export function WriteTokenCard() {
  return <ApiTokenCard kind="write" />
}
