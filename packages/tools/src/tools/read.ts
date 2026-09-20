import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";

const DEFAULT_LIMIT = 2000;

const ReadArgs = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(), // 1-based 起始行
  limit: z.number().int().positive().optional(),
});

/** read 工具：读文本文件，cat -n 风格带行号（对标 ZCode read） */
export const readTool: Tool = {
  definition: {
    name: "read",
    description: "读取文本文件，带行号返回；默认最多 2000 行",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对会话 cwd 或绝对路径）" },
        offset: { type: "integer", description: "1-based 起始行" },
        limit: { type: "integer", description: "返回行数上限，默认 2000" },
      },
      required: ["path"],
    },
    readOnly: true,
  },
  async execute(input, ctx) {
    const parsed = ReadArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    const { path, offset, limit } = parsed.data;
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);

    // 二进制文档类型重定向：read 只管文本，文档走 extract
    const lower = abs.toLowerCase();
    if (/\.(pdf|docx|xlsx|png|jpe?g|webp|gif|bmp)$/.test(lower)) {
      return {
        ok: false,
        output: "",
        error: `${path} 是文档/图片类型：请改用 extract 工具（支持 PDF/DOCX/XLSX/图片）`,
      };
    }

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
    if (content.includes("\0")) {
      return { ok: true, output: "[二进制文件，内容省略]" };
    }
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    const start = offset ?? 1;
    const max = limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(start - 1, start - 1 + max);
    if (slice.length === 0) {
      return { ok: true, output: `（空范围：文件共 ${lines.length} 行，请求从第 ${start} 行开始）` };
    }
    const body = slice.map((line, i) => `${String(start + i).padStart(6)}→${line}`).join("\n");
    return {
      ok: true,
      output: `${abs}（共 ${lines.length} 行，显示 ${start}-${start + slice.length - 1}）\n${body}`,
    };
  },
};
