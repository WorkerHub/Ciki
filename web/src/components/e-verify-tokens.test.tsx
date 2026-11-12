/**
 * 接口 E 单独立验证（Jim）·前端：设置页两张卡（三期 §5）。
 *
 * 环境：jsdom + Testing Library（组件级实测，不是真浏览器）。断言只来自冻结契约
 * 与矩阵里「两卡列表/新建/改名/改范围/吊销全流程；明文只出现一次；中英切换文案
 * 正确且中文保留 Token 英文词」这几条。
 *
 * 独立于主单自测：这里走的是**一条完整旅程**（同一组件实例里连续做五种操作，
 * 列表数据随每次操作的响应演进），而不是逐个动作各开一局。
 */
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiTokensCard } from "@/components/ApiTokensCard"
import { ImportTokensCard } from "@/components/ImportTokensCard"
import { i18n } from "@/i18n"
import type { ApiTokenSummary, ImportTokenSummary, Space } from "@/lib/api"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      tokens: vi.fn(),
      createToken: vi.fn(),
      renameToken: vi.fn(),
      setTokenSpaces: vi.fn(),
      revokeToken: vi.fn(),
      importTokens: vi.fn(),
      createImportToken: vi.fn(),
      revokeImportToken: vi.fn()
    }
  }
})

const { meApi } = await import("@/lib/api")

const CREATED_AT = "2026-11-12T02:00:00.000Z"
const OTHER_CREATED_AT = "2026-11-12T01:00:00.000Z"
const PLAINTEXT = "ciki_verify_plaintext_once"

const SPACES: Space[] = [
  {
    id: 1,
    slug: "space-1",
    name: "默认空间",
    description: "",
    myRole: "admin",
    isDefault: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z"
  },
  {
    id: 2,
    slug: "space-2",
    name: "研发空间",
    description: "",
    myRole: "editor",
    isDefault: false,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z"
  }
]

/** 两张卡的动态数据源：每次操作改这个数组，列表重拉就能看到变化。 */
let apiTokens: ApiTokenSummary[] = []
let importTokens: ImportTokenSummary[] = []

function resetApiTokens() {
  apiTokens = [
    {
      id: 7,
      name: "只读 Token",
      kind: "read",
      spaceIds: null,
      createdAt: OTHER_CREATED_AT,
      lastUsedAt: null
    },
    {
      id: 8,
      name: "Muse",
      kind: "write",
      spaceIds: [1, 2],
      createdAt: CREATED_AT,
      lastUsedAt: null
    }
  ]
}

function resetImportTokens() {
  importTokens = [
    {
      id: 4,
      name: "浏览器插件",
      createdAt: OTHER_CREATED_AT,
      lastUsedAt: null
    }
  ]
}

beforeEach(() => {
  useSpacesStore.setState({ spaces: SPACES, status: "ready", currentId: 1 })
  resetApiTokens()
  resetImportTokens()

  vi.mocked(meApi.tokens).mockImplementation(async () => ({
    tokens: apiTokens.map((row) => ({ ...row }))
  }))
  vi.mocked(meApi.createToken).mockImplementation(
    async (input: {
      kind: "read" | "write"
      name?: string
      spaceIds: number[] | null
    }) => {
      const created: ApiTokenSummary = {
        id: 9,
        name:
          input.name ?? (input.kind === "read" ? "只读 Token" : "读写 Token"),
        kind: input.kind,
        spaceIds: input.spaceIds,
        createdAt: CREATED_AT,
        lastUsedAt: null
      }
      apiTokens = [...apiTokens, created]
      return { ...created, token: PLAINTEXT }
    }
  )
  vi.mocked(meApi.renameToken).mockImplementation(
    async (id: number, name: string) => {
      apiTokens = apiTokens.map((row) =>
        row.id === id ? { ...row, name } : row
      )
      return {}
    }
  )
  vi.mocked(meApi.setTokenSpaces).mockImplementation(
    async (id: number, spaceIds: number[] | null) => {
      apiTokens = apiTokens.map((row) =>
        row.id === id ? { ...row, spaceIds } : row
      )
      return { spaceIds }
    }
  )
  vi.mocked(meApi.revokeToken).mockImplementation(async (id: number) => {
    apiTokens = apiTokens.filter((row) => row.id !== id)
    return { success: true }
  })

  vi.mocked(meApi.importTokens).mockImplementation(async () => ({
    tokens: importTokens.map((row) => ({ ...row }))
  }))
  vi.mocked(meApi.createImportToken).mockImplementation(
    async (name?: string) => {
      const created: ImportTokenSummary = {
        id: 5,
        name: name ?? "浏览器插件",
        createdAt: CREATED_AT,
        lastUsedAt: null
      }
      importTokens = [...importTokens, created]
      return { ...created, token: PLAINTEXT }
    }
  )
  vi.mocked(meApi.revokeImportToken).mockImplementation(async (id: number) => {
    importTokens = importTokens.filter((row) => row.id !== id)
    return { success: true }
  })
})

/** 断言行内文本（避免把同名的提示文案当成列表行）。 */
function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(name))
  if (!row) throw new Error(`找不到列表行：${name}`)
  return row
}

describe("E 验证·前端两卡", () => {
  it("API Token 卡一条旅程：列表 → 新建（类型+范围）→ 改名 → 改范围 → 吊销", async () => {
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    // 1) 列表：两条、类型徽标、范围摘要与使用情况
    expect(await screen.findByText("只读 Token")).toBeInTheDocument()
    const readRow = rowOf("只读 Token")
    const writeRow = rowOf("Muse")
    expect(within(readRow).getByText("只读")).toBeInTheDocument()
    expect(within(writeRow).getByText("读写")).toBeInTheDocument()
    expect(within(readRow).getByText("全部空间")).toBeInTheDocument()
    expect(within(writeRow).getByText("指定空间（2 个）")).toBeInTheDocument()
    expect(within(readRow).getByText(/尚未使用/)).toBeInTheDocument()

    // 2) 新建：切读写、填名、勾一个空间 → 三个字段一起提交
    await user.click(screen.getByRole("button", { name: "新建 Token" }))
    await user.click(screen.getByRole("radio", { name: "读写" }))
    expect(screen.getByText("留空将自动命名：读写 Token")).toBeInTheDocument()
    await user.type(screen.getByLabelText("名称"), "验证用读写")
    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    await user.click(screen.getByRole("checkbox", { name: "研发空间" }))
    await user.click(screen.getByRole("button", { name: "创建" }))

    expect(meApi.createToken).toHaveBeenCalledWith({
      kind: "write",
      name: "验证用读写",
      spaceIds: [2]
    })
    // 明文只出现一次，且提示明确「离开设置页后无法再查看」
    expect(await screen.findByText(PLAINTEXT)).toBeInTheDocument()
    expect(screen.getByText(/只显示这一次/)).toBeInTheDocument()
    // 创建成功后重拉列表，新行按服务端回执出现
    expect(await screen.findByText("验证用读写")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(PLAINTEXT)).toBeNull()

    // 3) 改名：服务端为准，列表重拉后显示新名字
    await user.click(
      within(rowOf("只读 Token")).getByRole("button", { name: "改名" })
    )
    expect(await screen.findByText("修改 Token 名称")).toBeInTheDocument()
    const nameInput = screen.getByLabelText("名称")
    await user.clear(nameInput)
    await user.type(nameInput, "外部只读")
    await user.click(screen.getByRole("button", { name: "保存" }))
    expect(meApi.renameToken).toHaveBeenCalledWith(7, "外部只读")
    expect(await screen.findByText("外部只读")).toBeInTheDocument()
    expect(screen.queryByText("名称已修改。")).not.toBeNull()

    // 4) 改范围：只动范围、不换令牌
    const renamedRow = rowOf("外部只读")
    await user.click(within(renamedRow).getByRole("button", { name: "改范围" }))
    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    await user.click(screen.getByRole("checkbox", { name: "研发空间" }))
    await user.click(screen.getByRole("button", { name: "保存范围" }))
    expect(meApi.setTokenSpaces).toHaveBeenCalledWith(7, [2])
    expect(meApi.createToken).toHaveBeenCalledTimes(1)
    expect(
      await within(rowOf("外部只读")).findByText("指定空间（1 个）")
    ).toBeInTheDocument()

    // 5) 吊销：二次确认后才调接口，成功后从列表消失
    await user.click(
      within(rowOf("Muse")).getByRole("button", { name: "吊销" })
    )
    expect(await screen.findByText("吊销这个 Token？")).toBeInTheDocument()
    expect(meApi.revokeToken).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "吊销 Token" }))
    expect(meApi.revokeToken).toHaveBeenCalledWith(8)
    expect(await screen.findByText(/Token 已吊销/)).toBeInTheDocument()
    expect(screen.queryByText("Muse")).toBeNull()
    expect(await screen.findByText("验证用读写")).toBeInTheDocument()
  })

  it("明文只出现一次：关掉提示、重挂载、查存储都不再出现", async () => {
    const user = userEvent.setup()
    const first = render(<ApiTokensCard />)
    await screen.findByText("只读 Token")

    await user.click(screen.getByRole("button", { name: "新建 Token" }))
    await user.click(screen.getByRole("button", { name: "创建" }))
    expect(await screen.findByText(PLAINTEXT)).toBeInTheDocument()
    // 明文只出现在那一个 code 块里，列表行不带它
    expect(screen.getAllByText(PLAINTEXT)).toHaveLength(1)
    expect(meApi.tokens).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(PLAINTEXT)).toBeNull()

    // 重挂载（等价于离开再回设置页）：列表里没有任何明文
    first.unmount()
    render(<ApiTokensCard />)
    await screen.findByText("Muse")
    expect(screen.queryByText(PLAINTEXT)).toBeNull()

    // 也不落任何前端存储 / DOM 残留
    expect(JSON.stringify(localStorage)).not.toContain(PLAINTEXT)
    expect(JSON.stringify(sessionStorage)).not.toContain(PLAINTEXT)
    expect(document.body.textContent ?? "").not.toContain(PLAINTEXT)
  })

  it("浏览器插件卡一条旅程：列表 → 新建（留空自动名）→ 明文一次 → 吊销", async () => {
    const user = userEvent.setup()
    render(<ImportTokensCard />)

    expect(await screen.findByText("浏览器插件")).toBeInTheDocument()
    expect(screen.getByText(/创建于/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "新建凭证" }))
    expect(screen.getByText("留空将自动命名：浏览器插件")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "创建" }))
    // 留空不带 name，让服务端落默认名
    expect(meApi.createImportToken).toHaveBeenCalledWith(undefined)
    expect(await screen.findByText(PLAINTEXT)).toBeInTheDocument()
    expect(screen.getAllByText(PLAINTEXT)).toHaveLength(1)
    expect(screen.getByText(/粘贴到浏览器插件/)).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(PLAINTEXT)).toBeNull()

    await user.click(
      within(rowOf("浏览器插件")).getByRole("button", { name: "吊销" })
    )
    expect(await screen.findByText("吊销这个凭证？")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "吊销凭证" }))
    expect(meApi.revokeImportToken).toHaveBeenCalled()
    expect(await screen.findByText(/凭证已吊销/)).toBeInTheDocument()
  })

  it("中英切换：两卡文案随语言切换，中文始终保留 Token 英文词", async () => {
    vi.mocked(meApi.tokens).mockResolvedValue({ tokens: [] })
    vi.mocked(meApi.importTokens).mockResolvedValue({ tokens: [] })
    render(
      <>
        <ApiTokensCard />
        <ImportTokensCard />
      </>
    )

    // 中文：标题与按钮保留 Token 英文词
    expect(await screen.findByText("还没有 API Token")).toBeInTheDocument()
    expect(screen.getByText("API Token")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "新建 Token" })
    ).toBeInTheDocument()
    expect(screen.getByText("还没有插件凭证")).toBeInTheDocument()
    expect(screen.getByText("浏览器插件")).toBeInTheDocument()

    // 中文的空态/按钮/提示里，Token 是英文原词（不是「令牌/凭证」硬译）
    for (const label of [
      screen.getByRole("button", { name: "新建 Token" }).textContent ?? "",
      screen.getByText("还没有 API Token").textContent ?? "",
      screen.getByText("API Token").textContent ?? ""
    ]) {
      expect(label).toContain("Token")
    }

    // 打开新建面，中文提示也带 Token
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "新建 Token" }))
    expect(screen.getByText("留空将自动命名：只读 Token")).toBeInTheDocument()
    expect(
      screen.getByText("留空将自动命名：只读 Token").textContent
    ).toContain("Token")

    // 切到英文：两卡都换文案，不再有中文
    await act(async () => {
      await i18n.changeLanguage("en")
    })
    expect(await screen.findByText("No API Token yet")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "New Token" })
    ).toBeInTheDocument()
    expect(screen.getByText("Browser extension")).toBeInTheDocument()
    expect(
      screen.getByText("Leave blank to name it Read-only Token")
    ).toBeInTheDocument()
    expect(screen.queryByText("还没有 API Token")).toBeNull()
    expect(screen.queryByText("新建凭证")).toBeNull()

    // 切回中文：文案回来，Token 仍是英文词
    await act(async () => {
      await i18n.changeLanguage("zh")
    })
    expect(await screen.findByText("还没有 API Token")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "新建 Token" }).textContent
    ).toContain("Token")
  })
})
