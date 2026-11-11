/**
 * 评论能力的唯一判定点（与 `space-access.ts` 的分工一致：SQL 查事实、这里判能力）。
 *
 * - 读与发表：只要对该页有读权限（`resolveSpaceRole` 返回任一角色即可），登录由
 *   会话中间件保证——`viewer` 也能评，这是规格「能读的人就能评论」的原话。
 * - 编辑：只有作者本人（正文）。
 * - 删除：作者本人，或该页所属空间的 `admin`，或站点管理员。
 *   站点管理员经 `resolveSpaceRole` 已归一成 `admin`，所以这里只认 `admin` 一个值，
 *   不在路由层另写「是不是站点管理员」的分支。
 */
import type { SpaceRole } from "./space-access"

export function canEditComment(authorId: string, userId: string): boolean {
  return authorId === userId
}

export function canDeleteComment(
  role: SpaceRole | null,
  authorId: string,
  userId: string
): boolean {
  if (!role) return false
  return authorId === userId || role === "admin"
}
