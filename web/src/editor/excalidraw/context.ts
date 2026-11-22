import { createContext, useContext } from "react"

export interface CanvasPageContextValue {
  pageId?: number
  canWrite?: boolean
}

export const CanvasPageContext = createContext<CanvasPageContextValue>({
  pageId: undefined,
  canWrite: false
})

export function useCanvasPageContext(): CanvasPageContextValue {
  return useContext(CanvasPageContext)
}
