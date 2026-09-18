import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { displayPath, resolveInCtx } from "./paths.js";

const WriteArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
});

/** write 工具：创建/覆盖文件（readOnly=false，默认预设下走 ask 确认） */
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
  async execute(input, ctx) {
    const parsed = WriteArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { path, content } = parsed.data;
    const abs = resolveInCtx(path, ctx);
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
