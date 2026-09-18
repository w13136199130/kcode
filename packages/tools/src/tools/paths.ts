import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolContext } from "@kcode/contracts";

/** 工具路径解析：相对路径以会话 cwd 为基准（§5.1 ToolContext.cwd） */
export function resolveInCtx(path: string, ctx: ToolContext): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
}

/** 展示路径：cwd 内显示相对路径，跨界显示绝对 */
export function displayPath(abs: string, ctx: ToolContext): string {
  if (ctx.cwd === undefined) return abs;
  const rel = relative(ctx.cwd, abs);
  const escapes = rel === "" || rel.split(sep)[0] === "..";
  return escapes ? abs : rel;
}
