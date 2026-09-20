import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";
import { displayPath, resolveInCtx } from "./paths.js";

const WriteArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
});

/**
 * 工作区边界检查：解析后的绝对路径在会话工作目录之外时返回告警提示，
 * 由权限引擎的 ask 确认兜底——工作区外写入必须用户显式同意。
 */
function workspaceBoundaryWarning(abs: string, ctx: ToolContext): string | undefined {
  if (ctx.cwd === undefined) {
    return undefined;
  }
  const rel = relative(ctx.cwd, abs);
  if (rel === "" || rel.split(sep)[0] === "..") {
    return `路径 ${abs} 在工作区 ${ctx.cwd} 之外，请确认是否允许`;
  }
  return undefined;
}

/** write 工具：创建/覆盖文件（工作区外写入在权限确认时附带边界提示） */
export const writeTool: Tool = {
  definition: {
    name: "write",
    description: "创建或覆盖文件（整文件写入，自动建父目录）；执行前需用户确认",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对会话 cwd 或绝对）" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    readOnly: false,
  },
  async execute(input, ctx): Promise<ToolOutput> {
    const parsed = WriteArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { path, content } = parsed.data;
    const abs = resolveInCtx(path, ctx);
    const boundary = workspaceBoundaryWarning(abs, ctx);
    if (boundary !== undefined) {
      // 返回告警但不阻止——权限引擎的 ask 确认是最终门控
      return { ok: false, output: "", error: boundary };
    }
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
    const lines = content === "" ? 0 : content.split(/\r?\n/).length;
    return { ok: true, output: `已写入 ${displayPath(abs, ctx)}（${lines} 行）` };
  },
};
