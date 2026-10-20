import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";
import { displayPath, isWithinWorkspace, resolveInCtx } from "./paths.js";
import { atomicWriteText } from "./atomic-write.js";
import { recordRead, verifyReadBeforeWrite } from "./read-state.js";

const WriteArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
});

/**
 * 工作区边界检查：工作区外返回错误（工具层硬边界）。
 *
 * 已知取舍：权限 ask 发生在工具执行之前，用户批准越界路径后仍会被这里拒绝。
 * 后续把边界判定上移到权限引擎（越界 → ask），而不是工具内直接 deny；
 * 当前先保证跨盘/UNC 不再被误判为"工作区内"。
 */
function workspaceBoundaryWarning(abs: string, ctx: ToolContext): string | undefined {
  if (ctx.cwd === undefined) {
    return undefined;
  }
  if (!isWithinWorkspace(ctx.cwd, abs)) {
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
    permission: { default: "ask", acceptEdits: "allow" },
    timeoutMs: 30_000,
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
    // 3-09：覆盖已存在文件必须先 read，且 read 后内容未变；新建文件不受限
    if (ctx.reads !== undefined && existsSync(abs)) {
      let current: string;
      try {
        current = await readFile(abs, "utf8");
      } catch (err) {
        return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
      const stale = verifyReadBeforeWrite(ctx, abs, current);
      if (stale !== undefined) {
        return { ok: false, output: "", error: stale };
      }
    }
    try {
      await atomicWriteText(abs, content);
      await recordRead(ctx, abs, content);
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
    const lines = content === "" ? 0 : content.split(/\r?\n/).length;
    return { ok: true, output: `已写入 ${displayPath(abs, ctx)}（${lines} 行）` };
  },
};
