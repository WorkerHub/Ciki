import type { Context, Next } from "hono"
import type { HonoEnv } from "../types"

export async function adminMiddleware(c: Context<HonoEnv>, next: Next) {
  if (c.get("role") !== "admin") {
    return c.json({ error: "Forbidden: admin access required" }, 403)
  }
  await next()
}
