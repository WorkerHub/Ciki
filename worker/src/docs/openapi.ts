/**
 * Ciki OpenAPI 3.1 规范生成器。
 *
 * 覆盖对外开放的全部令牌读写接口、Agent 评论端点与公开发现面。
 * 版本号与实例构建版本严格同源（info.version），包含契约版本 x-contract-version。
 */

export const CONTRACT_VERSION = "1.0.0"

export function buildOpenApiSpec(version: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Ciki API",
      version,
      description:
        "Ciki 知识库实例对外接口规范。包含只读令牌 API、读写令牌 API、Agent 评论写端点及公开发现入口。",
      "x-contract-version": CONTRACT_VERSION
    },
    servers: [
      {
        url: "/",
        description: "当前 Ciki 实例"
      }
    ],
    components: {
      securitySchemes: {
        ReadTokenAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "只读 API 令牌（Authorization: Bearer <token>）。校验链：令牌→所属账号→目标空间成员（具备任意成员角色且空间在令牌授权范围内）。"
        },
        WriteTokenAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "读写 API 令牌（Authorization: Bearer <token>）。校验链：令牌→所属账号→目标空间成员（具备 editor 及以上角色且空间在令牌授权范围内）。"
        }
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "string",
              description: "错误信息描述"
            },
            code: {
              type: "string",
              description: "业务错误代码（可选）"
            }
          }
        },
        PublicInfoResponse: {
          type: "object",
          required: [
            "name",
            "repositoryUrl",
            "version",
            "openapi",
            "agentGuide"
          ],
          properties: {
            name: { type: "string", description: "站点名称" },
            repositoryUrl: { type: "string", description: "项目开源仓库地址" },
            version: { type: "string", description: "实例构建版本号" },
            openapi: {
              type: "string",
              description: "OpenAPI 3.1 规范端点路径"
            },
            agentGuide: { type: "string", description: "Agent 说明页端点路径" }
          }
        },
        SpaceDto: {
          type: "object",
          required: ["id", "name", "slug"],
          properties: {
            id: { type: "integer", description: "空间 ID" },
            name: { type: "string", description: "空间名称" },
            slug: { type: "string", description: "空间短链标识" }
          }
        },
        SpacesListResponse: {
          type: "object",
          required: ["spaces"],
          properties: {
            spaces: {
              type: "array",
              items: { $ref: "#/components/schemas/SpaceDto" }
            }
          }
        },
        TreeItemDto: {
          type: "object",
          required: [
            "id",
            "title",
            "parent_id",
            "space_id",
            "sort_order",
            "updated_at"
          ],
          properties: {
            id: { type: "integer", description: "页面 ID" },
            title: { type: "string", description: "页面标题纯文本" },
            parent_id: {
              type: ["integer", "null"],
              description: "父页面 ID，根级为 null"
            },
            space_id: { type: "integer", description: "所属空间 ID" },
            sort_order: { type: "integer", description: "同级排序序号" },
            updated_at: {
              type: "string",
              format: "date-time",
              description: "更新时间"
            }
          }
        },
        SearchItemDto: {
          type: "object",
          required: ["id", "title", "snippet", "updated_at"],
          properties: {
            id: { type: "integer", description: "页面 ID" },
            title: { type: "string", description: "页面标题" },
            snippet: {
              type: "string",
              description: "带匹配高亮标记的内容摘要"
            },
            updated_at: {
              type: "string",
              format: "date-time",
              description: "更新时间"
            }
          }
        },
        PageReadResponse: {
          type: "object",
          required: [
            "id",
            "title",
            "parent_id",
            "space_id",
            "sort_order",
            "created_at",
            "updated_at"
          ],
          properties: {
            id: { type: "integer", description: "页面 ID" },
            title: { type: "string", description: "页面标题" },
            parent_id: { type: ["integer", "null"], description: "父页面 ID" },
            space_id: { type: "integer", description: "所属空间 ID" },
            sort_order: { type: "integer", description: "同级排序序号" },
            created_at: {
              type: "string",
              format: "date-time",
              description: "创建时间"
            },
            updated_at: {
              type: "string",
              format: "date-time",
              description: "更新时间"
            },
            markdown: {
              type: "string",
              description: "派生纯文本 Markdown（format!=json 时包含）"
            },
            content_json: {
              type: "object",
              description: "TipTap/ProseMirror 文档结构（format=json 时包含）"
            }
          }
        },
        PageMetaResponse: {
          type: "object",
          required: [
            "id",
            "space_id",
            "parent_id",
            "sort_order",
            "title",
            "updated_at"
          ],
          properties: {
            id: { type: "integer", description: "页面 ID" },
            space_id: { type: "integer", description: "所属空间 ID" },
            parent_id: { type: ["integer", "null"], description: "父页面 ID" },
            sort_order: { type: "integer", description: "同级排序序号" },
            title: { type: "string", description: "页面标题" },
            updated_at: {
              type: "string",
              format: "date-time",
              description: "更新时间"
            }
          }
        },
        CreatePageRequest: {
          type: "object",
          required: ["title", "content_json"],
          properties: {
            space_id: {
              type: "integer",
              description: "目标空间 ID（可选，缺省为默认空间）"
            },
            parent_id: {
              type: ["integer", "null"],
              description: "父页面 ID（可选，缺省为根级）"
            },
            title: { type: "string", description: "页面标题（1-255 字符）" },
            content_json: {
              description: "TipTap JSON 对象或 JSON 字符串",
              oneOf: [{ type: "object" }, { type: "string" }]
            }
          }
        },
        UpdatePageRequest: {
          type: "object",
          properties: {
            title: { type: "string", description: "新页面标题（可选）" },
            content_json: {
              description:
                "TipTap JSON 对象或 JSON 字符串（可选，title 与 content_json 至少传一项）",
              oneOf: [{ type: "object" }, { type: "string" }]
            }
          }
        },
        MovePageRequest: {
          type: "object",
          required: ["parent_id", "index"],
          properties: {
            parent_id: {
              type: ["integer", "null"],
              description: "目标父页面 ID，根级为 null"
            },
            index: {
              type: "integer",
              minimum: 0,
              description: "同级从 0 开始的排序序号"
            },
            space_id: {
              type: "integer",
              description: "目标空间 ID（跨空间移动时传入，缺省为当前空间）"
            }
          }
        },
        SuccessResponse: {
          type: "object",
          required: ["success"],
          properties: {
            success: { type: "boolean", enum: [true] }
          }
        },
        FileUploadResponse: {
          type: "object",
          required: ["key", "url", "contentType", "size"],
          properties: {
            key: { type: "string", description: "上传资源唯一存储键" },
            url: { type: "string", description: "资源访问相对路径" },
            contentType: { type: "string", description: "资源 MIME 类型" },
            size: { type: "integer", description: "文件大小（字节）" }
          }
        },
        CommentPreviewRequest: {
          type: "object",
          required: ["bodyMd"],
          properties: {
            bodyMd: { type: "string", description: "待预览的 Markdown 原文" }
          }
        },
        CommentPreviewResponse: {
          type: "object",
          required: ["html"],
          properties: {
            html: { type: "string", description: "渲染净化后的 HTML 内容" }
          }
        },
        CreateCommentRequest: {
          type: "object",
          required: ["bodyMd"],
          properties: {
            bodyMd: { type: "string", description: "评论 Markdown 原文" },
            parentId: {
              type: ["integer", "null"],
              description: "被回复评论 ID（一级串结构，回复子评论自动归一）"
            }
          }
        },
        UpdateCommentRequest: {
          type: "object",
          required: ["bodyMd"],
          properties: {
            bodyMd: {
              type: "string",
              description: "修改后的评论 Markdown 原文"
            }
          }
        },
        CommentDto: {
          type: "object",
          required: [
            "id",
            "parentId",
            "authorId",
            "authorName",
            "authorAvatarUrl",
            "isAgent",
            "ownerName",
            "bodyMd",
            "html",
            "createdAt",
            "editedAt",
            "deletedAt",
            "canEdit",
            "canDelete"
          ],
          properties: {
            id: { type: "integer", description: "评论 ID" },
            parentId: { type: ["integer", "null"], description: "父评论 ID" },
            authorId: { type: "integer", description: "作者用户 ID" },
            authorName: { type: "string", description: "作者显示名" },
            authorAvatarUrl: {
              type: ["string", "null"],
              description: "作者头像地址"
            },
            isAgent: { type: "boolean", description: "作者是否为 Agent 账号" },
            ownerName: {
              type: ["string", "null"],
              description: "Agent 所属 owner 用户名"
            },
            bodyMd: { type: "string", description: "Markdown 原文" },
            html: { type: "string", description: "服务端渲染净化后的 HTML" },
            createdAt: {
              type: "string",
              format: "date-time",
              description: "创建时间"
            },
            editedAt: {
              type: ["string", "null"],
              format: "date-time",
              description: "最后修改时间"
            },
            deletedAt: {
              type: ["string", "null"],
              format: "date-time",
              description: "删除时间"
            },
            canEdit: { type: "boolean", description: "当前调用方是否有权编辑" },
            canDelete: {
              type: "boolean",
              description: "当前调用方是否有权删除"
            }
          }
        }
      }
    },
    paths: {
      "/api/public": {
        get: {
          summary: "公开引导与自述发现入口",
          description:
            "免鉴权只读端点，提供当前部署版本、站点名称、仓库地址及 OpenAPI / Agent 指引发现入口。",
          responses: {
            "200": {
              description: "成功获取公开信息",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicInfoResponse" }
                }
              }
            }
          }
        }
      },
      "/api/openapi.json": {
        get: {
          summary: "获取 OpenAPI 3.1 规范 JSON",
          description:
            "免鉴权只读端点，返回当前部署版本同源的 OpenAPI 3.1 规范定义。",
          responses: {
            "200": {
              description: "OpenAPI 3.1 JSON 规范",
              content: {
                "application/json": {
                  schema: { type: "object" }
                }
              }
            }
          }
        }
      },
      "/api/public/agent-guide": {
        get: {
          summary: "获取写文档 Agent 接入指引",
          description:
            "免鉴权只读端点，返回带有部署版本与契约版本页首的 Markdown 纯文本文档。",
          responses: {
            "200": {
              description: "Markdown 纯文本文档",
              content: {
                "text/markdown; charset=utf-8": {
                  schema: { type: "string" }
                }
              }
            }
          }
        }
      },
      "/api/read/spaces": {
        get: {
          summary: "获取只读令牌可见空间列表",
          description:
            "查询当前令牌所属用户具备成员资格且在令牌授权范围内的空间列表。",
          security: [{ ReadTokenAuth: [] }, { WriteTokenAuth: [] }],
          responses: {
            "200": {
              description: "空间列表",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SpacesListResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/read/tree": {
        get: {
          summary: "获取页面树",
          description:
            "按扁平列表形式返回未删除页面。可通过 parent_id 自行组装树形层级。",
          security: [{ ReadTokenAuth: [] }, { WriteTokenAuth: [] }],
          parameters: [
            {
              name: "space_id",
              in: "query",
              required: false,
              schema: { type: "integer" },
              description:
                "指定空间 ID。省略时按令牌授权范围包含的所有可见空间聚合"
            }
          ],
          responses: {
            "200": {
              description: "页面扁平列表",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/TreeItemDto" }
                  }
                }
              }
            },
            "401": {
              description: "未携带合法令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/read/search": {
        get: {
          summary: "全文检索页面",
          description:
            "在令牌可见范围内对页面标题与正文执行 FTS5 全文检索，返回相关度排序的结果及高亮摘要。",
          security: [{ ReadTokenAuth: [] }, { WriteTokenAuth: [] }],
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "检索关键词"
            },
            {
              name: "space_id",
              in: "query",
              required: false,
              schema: { type: "integer" },
              description: "限定空间 ID"
            }
          ],
          responses: {
            "200": {
              description: "搜索命中项列表",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SearchItemDto" }
                  }
                }
              }
            },
            "401": {
              description: "未携带合法令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/read/pages/{id}": {
        get: {
          summary: "获取页面详情",
          description:
            "获取单页详情。默认返回 markdown 字段；追加 ?format=json 参数返回编辑态完整 content_json。",
          security: [{ ReadTokenAuth: [] }, { WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面十进制正整数 ID"
            },
            {
              name: "format",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["json"] },
              description: "传 json 时返回 content_json，用于编辑写入"
            }
          ],
          responses: {
            "200": {
              description: "页面详情",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PageReadResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "页面不存在、已删除或无权访问",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/read/files/{key}": {
        get: {
          summary: "读取文件资产",
          description:
            "读取图片、场景 JSON 或 Embed HTML 资产。服务端严格比对上传者账号，非本账号上传回 404。",
          security: [{ ReadTokenAuth: [] }, { WriteTokenAuth: [] }],
          parameters: [
            {
              name: "key",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "资源存储键（如 pages/<uuid>.png）"
            }
          ],
          responses: {
            "200": {
              description: "二进制或文本文件内容流"
            },
            "401": {
              description: "未携带合法令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "文件不存在或无权访问（跨账号读取回 404）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/write/pages": {
        post: {
          summary: "创建页面",
          description:
            "创建新页面。正文只收 TipTap JSON（content_json），新页排同级末尾。",
          security: [{ WriteTokenAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreatePageRequest" }
              }
            }
          },
          responses: {
            "201": {
              description: "创建成功，返回新页元数据",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PageMetaResponse" }
                }
              }
            },
            "400": {
              description: "参数校验失败（INVALID_CONTENT_JSON 等）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "空间不存在或无权写入",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "409": {
              description: "父页已删除（PARENT_DELETED）或默认空间缺失",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "413": {
              description: "正文体积超限（PAYLOAD_TOO_LARGE）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/write/pages/{id}": {
        put: {
          summary: "修改页面",
          description:
            "更新页面正文或重命名。只传 content_json 时自动沿用现有标题。",
          security: [{ WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面 ID"
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdatePageRequest" }
              }
            }
          },
          responses: {
            "200": {
              description: "修改成功，返回更新后的元数据",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PageMetaResponse" }
                }
              }
            },
            "400": {
              description: "参数校验失败（INVALID_CONTENT_JSON 等）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "页面不存在或无权写入",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "413": {
              description: "正文体积超限（PAYLOAD_TOO_LARGE）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        },
        delete: {
          summary: "软删除页面",
          description: "将页面移入回收站，子树一同软删，可在回收站中恢复。",
          security: [{ WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面 ID"
            }
          ],
          responses: {
            "200": {
              description: "删除成功",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SuccessResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "页面不存在或无权删除",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/write/pages/{id}/move": {
        post: {
          summary: "移动页面",
          description:
            "更改父页面或调整同级序号，支持跨空间移动（要求源与目标空间均有写权限）。",
          security: [{ WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面 ID"
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MovePageRequest" }
              }
            }
          },
          responses: {
            "200": {
              description: "移动成功",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SuccessResponse" }
                }
              }
            },
            "400": {
              description: "请求参数不合法",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "源页面、目标父页或空间不存在或无权访问",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "409": {
              description:
                "结构冲突（PARENT_DELETED、SPACE_MISMATCH 或 PAGE_MOVE_CYCLE）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/write/files": {
        post: {
          summary: "上传图片或画布场景文件",
          description:
            "使用 multipart/form-data 上传正文图片（png/jpg/gif/webp，上限 10MB）或 Excalidraw 场景文件（.json，上限 2MB）。",
          security: [{ WriteTokenAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                      description: "待上传的文件内容"
                    }
                  }
                }
              }
            }
          },
          responses: {
            "201": {
              description: "上传成功",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FileUploadResponse" }
                }
              }
            },
            "400": {
              description: "文件格式不支持或字段缺失",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "413": {
              description: "文件体积超出上限（FILE_TOO_LARGE）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/write/files/embeds": {
        post: {
          summary: "上传 HTML Embed 文件",
          description:
            "使用 multipart/form-data 上传 HTML 嵌入部件（.html，上限 1MB）。",
          security: [{ WriteTokenAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                      description: "待上传的 .html 文件"
                    }
                  }
                }
              }
            }
          },
          responses: {
            "201": {
              description: "上传成功",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FileUploadResponse" }
                }
              }
            },
            "400": {
              description: "仅接受 .html 文件或缺失表单字段",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "413": {
              description: "文件体积超出 1MB 上限（FILE_TOO_LARGE）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/pages/{id}/comments/preview": {
        post: {
          summary: "预览评论 Markdown 渲染",
          description:
            "接收 Markdown 文本并返回服务端渲染净化后的 HTML，不落库不写表。",
          security: [{ WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面 ID"
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CommentPreviewRequest" }
              }
            }
          },
          responses: {
            "200": {
              description: "预览渲染成功",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CommentPreviewResponse"
                  }
                }
              }
            },
            "400": {
              description: "空正文等校验失败",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "页面不存在或无权访问",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "413": {
              description: "正文体积超限",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/pages/{id}/comments": {
        post: {
          summary: "发表评论",
          description:
            "持 write 令牌以 Agent 身份发表评论。支持传 parentId 进行一级串回复。",
          security: [{ WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面 ID"
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateCommentRequest" }
              }
            }
          },
          responses: {
            "201": {
              description: "发表成功",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CommentDto" }
                }
              }
            },
            "400": {
              description: "空正文等校验失败",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "页面不存在、父评论不存在或无权发表",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "413": {
              description: "正文体积超限",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      },
      "/api/pages/{id}/comments/{commentId}": {
        put: {
          summary: "编辑评论",
          description: "修改已发表评论的正文。仅限评论作者本人（当前 Agent）。",
          security: [{ WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面 ID"
            },
            {
              name: "commentId",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "评论 ID"
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateCommentRequest" }
              }
            }
          },
          responses: {
            "200": {
              description: "编辑成功",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CommentDto" }
                }
              }
            },
            "400": {
              description: "空正文校验失败",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "403": {
              description: "非作者本人无权编辑",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "页面或评论不存在",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "409": {
              description: "评论已处于删除状态（COMMENT_DELETED）",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        },
        delete: {
          summary: "删除评论",
          description: "软删除评论。作者本人、空间管理员或站点管理员有权删除。",
          security: [{ WriteTokenAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "页面 ID"
            },
            {
              name: "commentId",
              in: "path",
              required: true,
              schema: { type: "integer" },
              description: "评论 ID"
            }
          ],
          responses: {
            "200": {
              description: "删除成功",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SuccessResponse" }
                }
              }
            },
            "401": {
              description: "未携带合法写令牌",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "403": {
              description: "无权删除该评论",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            },
            "404": {
              description: "页面或评论不存在",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" }
                }
              }
            }
          }
        }
      }
    }
  }
}
