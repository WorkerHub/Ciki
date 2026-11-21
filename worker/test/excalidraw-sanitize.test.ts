import { describe, expect, it } from "vitest"
import {
  ALLOWED_ELEMENT_TYPES,
  safeJsonParse,
  sanitizeAppState,
  sanitizeElement,
  sanitizeExcalidrawScene,
  sanitizeExcalidrawSceneJson
} from "../src/lib/excalidraw-sanitize"

describe("Excalidraw 场景 JSON 消毒白名单", () => {
  const validScene = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      {
        id: "rect-1",
        type: "rectangle",
        x: 10,
        y: 20,
        width: 100,
        height: 80,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        boundElements: null,
        locked: false,
        link: "https://example.com/docs"
      },
      {
        id: "text-1",
        type: "text",
        x: 15,
        y: 25,
        width: 50,
        height: 20,
        angle: 0,
        strokeColor: "#000000",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        text: "测试文本",
        originalText: "测试文本",
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        baseline: 18,
        lineHeight: 1.25,
        containerId: "rect-1",
        autoResize: true,
        link: "/pages/home"
      }
    ],
    appState: {
      viewBackgroundColor: "#ffffff",
      gridSize: 20,
      exportWithDarkMode: false,
      exportBackground: true,
      exportPadding: 10
    },
    files: {
      dummy: "anything"
    }
  }

  it("合法场景完整放行，且 files 强制置为 {}", () => {
    const sanitized = sanitizeExcalidrawScene(validScene)
    expect(sanitized).not.toBeNull()
    expect(sanitized?.type).toBe("excalidraw")
    expect(sanitized?.version).toBe(2)
    expect(sanitized?.source).toBe("https://excalidraw.com")
    expect(sanitized?.elements).toHaveLength(2)
    expect(sanitized?.elements[0].id).toBe("rect-1")
    expect(sanitized?.elements[0].link).toBe("https://example.com/docs")
    expect(sanitized?.elements[1].text).toBe("测试文本")
    expect(sanitized?.elements[1].link).toBe("/pages/home")
    expect(sanitized?.appState.viewBackgroundColor).toBe("#ffffff")
    expect(sanitized?.appState.gridSize).toBe(20)
    expect(sanitized?.files).toEqual({})
  })

  it("顶层非对象、type 不是 excalidraw、version 不是 2 或 elements 不是数组时返回 null", () => {
    expect(sanitizeExcalidrawScene(null)).toBeNull()
    expect(sanitizeExcalidrawScene("string")).toBeNull()
    expect(sanitizeExcalidrawScene([])).toBeNull()
    expect(
      sanitizeExcalidrawScene({ ...validScene, type: "custom-draw" })
    ).toBeNull()
    expect(sanitizeExcalidrawScene({ ...validScene, version: 1 })).toBeNull()
    expect(sanitizeExcalidrawScene({ ...validScene, elements: {} })).toBeNull()
  })

  it("元素类型白名单：放行 9 种几何/文本/框架类型，严格剥除 embeddable/iframe/image 等", () => {
    for (const type of ALLOWED_ELEMENT_TYPES) {
      const el = sanitizeElement({ id: "1", type, x: 0, y: 0 })
      expect(el).not.toBeNull()
      expect(el?.type).toBe(type)
    }

    const dangerousTypes = ["embeddable", "iframe", "image", "custom", "script"]
    for (const type of dangerousTypes) {
      const el = sanitizeElement({
        id: "evil",
        type,
        x: 0,
        y: 0,
        link: "https://evil.com"
      })
      expect(el).toBeNull()
    }
  })

  it("元素属性白名单：剥除 customData 及未声明键", () => {
    const el = sanitizeElement({
      id: "rect-1",
      type: "rectangle",
      x: 10,
      y: 20,
      customData: { token: "secret", execute: "evil()" },
      unknownKey: "strip-me",
      __proto__: { injected: "polluted" }
    })
    expect(el).not.toBeNull()
    expect(el?.id).toBe("rect-1")
    expect(el?.customData).toBeUndefined()
    expect(el?.unknownKey).toBeUndefined()
  })

  it("元素 link 校验：仅放行 ^https?:// 与站内绝对路径 /，其余清洗为 null", () => {
    const safeLinks = [
      "https://example.com",
      "http://example.com/sub/path",
      "/wiki/page-1",
      "/api/files/pages/test.png"
    ]
    for (const link of safeLinks) {
      const el = sanitizeElement({
        id: "el",
        type: "rectangle",
        link
      })
      expect(el?.link).toBe(link)
    }

    const dangerousLinks = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "ftp://example.com",
      "//evil.com/relative-protocol",
      "file:///etc/passwd"
    ]
    for (const link of dangerousLinks) {
      const el = sanitizeElement({
        id: "el",
        type: "rectangle",
        link
      })
      expect(el?.link).toBeNull()
    }
  })

  it("元素 fontFamily 限制为 1-5，非法值被过滤", () => {
    for (let f = 1; f <= 5; f++) {
      const el = sanitizeElement({ id: "t", type: "text", fontFamily: f })
      expect(el?.fontFamily).toBe(f)
    }

    for (const invalid of [0, 6, -1, 99, "Arial", null, {}]) {
      const el = sanitizeElement({ id: "t", type: "text", fontFamily: invalid })
      expect(el?.fontFamily).toBeUndefined()
    }
  })

  it("appState 仅保留 5 个允许字段，非法色值与编辑态临时字段一律剥除", () => {
    const rawState = {
      viewBackgroundColor: "#AABBCC",
      gridSize: 15,
      exportWithDarkMode: true,
      exportBackground: false,
      exportPadding: 20,
      zoom: { value: 1.5 },
      scrollX: 100,
      scrollY: 200,
      selectedElementIds: { "rect-1": true },
      collaborators: [{ id: "user1" }]
    }
    const clean = sanitizeAppState(rawState)
    expect(clean).toEqual({
      viewBackgroundColor: "#aabbcc",
      gridSize: 15,
      exportWithDarkMode: true,
      exportBackground: false,
      exportPadding: 20
    })

    // 非法颜色（非 hex）丢弃
    const invalidColor = sanitizeAppState({
      viewBackgroundColor: "rgb(255,0,0); alert(1)"
    })
    expect(invalidColor.viewBackgroundColor).toBeUndefined()
  })

  it("防原型污染：safeJsonParse 擦除 __proto__ 与 constructor 键", () => {
    const payload =
      '{"type":"excalidraw","version":2,"elements":[],"appState":{},"__proto__":{"isAdmin":true},"constructor":{"prototype":{"evil":1}}}'
    const parsed = safeJsonParse(payload) as Record<string, unknown>
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect("isAdmin" in ({} as any)).toBe(false)
    expect("evil" in ({} as any)).toBe(false)

    const sanitized = sanitizeExcalidrawSceneJson(payload)
    expect(sanitized).not.toBeNull()
    expect((sanitized as any).isAdmin).toBeUndefined()
  })
})
