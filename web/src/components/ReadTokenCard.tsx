import { ApiTokenCard } from "@/components/ApiTokenCard"

/** 只读接口令牌（Muse 等外部只读客户端）：与导入令牌互相独立。 */
export function ReadTokenCard() {
  return <ApiTokenCard kind="read" />
}
