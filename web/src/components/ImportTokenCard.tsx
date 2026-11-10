import { ApiTokenCard } from "@/components/ApiTokenCard"

/** 导入令牌（插件专用）：交互与只读接口令牌共用 ApiTokenCard。 */
export function ImportTokenCard() {
  return <ApiTokenCard kind="import" />
}
