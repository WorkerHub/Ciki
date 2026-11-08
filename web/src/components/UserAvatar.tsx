import type { Me } from "@/lib/api"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

type AvatarUser = Pick<Me, "username" | "email" | "avatarUrl">

/** 顶栏/菜单/资料页统一的显示名：优先用户名，老后端缺字段时取邮箱前缀。 */
export function displayUsername(user: AvatarUser | null | undefined): string {
  const username = user?.username?.trim()
  if (username) return username
  const email = user?.email ?? ""
  return email.split("@")[0] || "用户"
}

/** 头像：有图显示图，没有（或加载失败）回退到显示名首字母圆。 */
export function UserAvatar({
  user,
  className
}: {
  user: AvatarUser | null | undefined
  className?: string
}) {
  const name = displayUsername(user)
  return (
    <Avatar className={className}>
      {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
      <AvatarFallback className="bg-primary font-semibold text-primary-foreground">
        {name.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}
