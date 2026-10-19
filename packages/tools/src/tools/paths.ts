import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolContext } from "@kcode/contracts";

/** 工具路径解析：相对路径以会话 cwd 为基准（§5.1 ToolContext.cwd） */
export function resolveInCtx(path: string, ctx: ToolContext): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
}

/**
 * 路径是否位于工作区子树内（含相等）。
 *
 * 不能用 `rel.split(sep)[0] === ".."`：Windows 跨盘时 `path.relative("E:\\ws","D:\\x")`
 * 返回绝对路径 `D:\x`，首段是 `D:` 而非 `..`，会被误判为工作区内。
 * 与 bash 的 isWithinPath 同口径：相对结果必须非绝对且不以 `..` 开头。
 * Windows 路径大小写不敏感，比较前统一 resolve + lowercase。
 */
export function isWithinWorkspace(cwd: string, abs: string): boolean {
  const norm = (p: string): string => {
    const resolved = resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const rel = relative(norm(cwd), norm(abs));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** 展示路径：cwd 内显示相对路径，跨界显示绝对 */
export function displayPath(abs: string, ctx: ToolContext): string {
  if (ctx.cwd === undefined) return abs;
  if (!isWithinWorkspace(ctx.cwd, abs)) return abs;
  return relative(ctx.cwd, abs);
}
