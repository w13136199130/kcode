import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolOutput } from "@kcode/contracts";
import { atomicWriteText } from "./atomic-write.js";
import { displayPath, isWithinWorkspace, resolveInCtx } from "./paths.js";
import { recordRead, verifyReadBeforeWrite } from "./read-state.js";

const ApplyPatchArgs = z.object({ patch: z.string().min(1) });

type PatchFile =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; body: string[] };

/**
 * 3-07：Codex 风格多文件补丁。
 *
 * *** Begin Patch
 * *** Add File: path
 * +content
 * *** Update File: path
 * @@
 * -old
 * +new
 * *** Delete File: path
 * *** End Patch
 *
 * Update 内可有多段 @@ hunk；每段按顺序在游标后找连续旧行。
 */
export function parseApplyPatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") throw new Error("补丁必须以 *** Begin Patch 开头");
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim() === "*** End Patch") {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("补丁缺少 *** End Patch");
  const files: PatchFile[] = [];
  let i = 1;
  while (i < end) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const update = line.match(/^\*\*\* Update File: (.+)$/);
    const del = line.match(/^\*\*\* Delete File: (.+)$/);
    if (add === null && update === null && del === null) {
      throw new Error(`无法识别的补丁行：${line}`);
    }
    const path = (add ?? update ?? del)![1]!.trim();
    const body: string[] = [];
    i++;
    while (i < end && !(lines[i] ?? "").startsWith("*** ")) {
      body.push(lines[i] ?? "");
      i++;
    }
    if (add !== null) {
      if (body.some((l) => !l.startsWith("+"))) {
        throw new Error(`Add File ${path} 的内容行必须以 + 开头`);
      }
      const content = body.map((l) => l.slice(1)).join("\n");
      files.push({ kind: "add", path, content: content === "" ? "" : `${content}\n` });
    } else if (del !== null) {
      files.push({ kind: "delete", path });
    } else {
      files.push({ kind: "update", path, body });
    }
  }
  if (files.length === 0) throw new Error("补丁没有文件操作");
  return files;
}

interface Staged {
  path: string;
  abs: string;
  before: string | null;
  after: string | null;
}

export const applyPatchTool: Tool = {
  definition: {
    name: "apply_patch",
    description:
      "一次提交多个文件的新增/修改/删除（Codex 风格 *** Begin Patch）。修改前需先 read；全部校验通过后才落盘",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "*** Begin Patch\\n*** Add File: a.ts\\n+...\\n*** Update File: b.ts\\n@@\\n-old\\n+new\\n*** Delete File: c.ts\\n*** End Patch",
        },
      },
      required: ["patch"],
    },
    readOnly: false,
    permission: { default: "ask", acceptEdits: "allow" },
    timeoutMs: 30_000,
  },

  async execute(input, ctx): Promise<ToolOutput> {
    const parsed = ApplyPatchArgs.safeParse(input);
    if (!parsed.success) {
      return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
    }
    let files: PatchFile[];
    try {
      files = parseApplyPatch(parsed.data.patch);
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }

    // 先全量校验并生成终态；任何文件失败都不落盘
    const staged: Staged[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const abs = resolveInCtx(file.path, ctx);
      if (seen.has(abs)) return { ok: false, output: "", error: `补丁重复操作同一文件：${file.path}` };
      seen.add(abs);
      if (ctx.cwd !== undefined && !isWithinWorkspace(ctx.cwd, abs)) {
        return { ok: false, output: "", error: `路径 ${abs} 在工作区 ${ctx.cwd} 之外` };
      }
      let before: string | null = null;
      if (existsSync(abs)) before = await readFile(abs, "utf8");
      if (file.kind === "add") {
        if (before !== null) return { ok: false, output: "", error: `新增文件已存在：${file.path}` };
        staged.push({ path: file.path, abs, before, after: file.content });
        continue;
      }
      if (before === null) return { ok: false, output: "", error: `文件不存在：${file.path}` };
      const stale = verifyReadBeforeWrite(ctx, abs, before);
      if (stale !== undefined) return { ok: false, output: "", error: stale };
      if (file.kind === "delete") {
        staged.push({ path: file.path, abs, before, after: null });
        continue;
      }
      let next: string;
      try {
        next = applyUpdate(before, file.body);
      } catch (err) {
        return { ok: false, output: "", error: `${file.path}: ${err instanceof Error ? err.message : String(err)}` };
      }
      staged.push({ path: file.path, abs, before, after: next });
    }

    // 落盘；中途失败按 before 逆序回滚已写文件（best-effort）
    const applied: Staged[] = [];
    try {
      for (const item of staged) {
        if (item.after === null) await rm(item.abs, { force: true });
        else await atomicWriteText(item.abs, item.after);
        applied.push(item);
      }
    } catch (err) {
      for (const item of applied.reverse()) {
        try {
          if (item.before === null) await rm(item.abs, { force: true });
          else await atomicWriteText(item.abs, item.before);
        } catch {
          // 回滚失败无法再做更多；把原始错误返回给模型
        }
      }
      return { ok: false, output: "", error: `落盘失败，已尝试回滚：${err instanceof Error ? err.message : String(err)}` };
    }

    for (const item of staged) {
      if (item.after !== null) await recordRead(ctx, item.abs, item.after);
    }
    const added = files.filter((f) => f.kind === "add").length;
    const updated = files.filter((f) => f.kind === "update").length;
    const deleted = files.filter((f) => f.kind === "delete").length;
    return {
      ok: true,
      output: `已应用补丁：新增 ${added} · 修改 ${updated} · 删除 ${deleted}（${staged.map((s) => displayPath(s.abs, ctx)).join("、")}）`,
    };
  },
};

function applyUpdate(original: string, body: string[]): string {
  const crlf = original.includes("\r\n");
  const current = original.replace(/\r\n/g, "\n").split("\n");
  const hunks: Array<{ oldLines: string[]; newLines: string[] }> = [];
  let oldLines: string[] = [];
  let newLines: string[] = [];
  const flush = (): void => {
    if (oldLines.length > 0 || newLines.length > 0) hunks.push({ oldLines, newLines });
    oldLines = [];
    newLines = [];
  };
  for (const line of body) {
    if (line.startsWith("@@")) {
      flush();
      continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line === "") {
      oldLines.push("");
      newLines.push("");
    } else {
      throw new Error(`补丁行缺少前缀（+/-/空格）：${line}`);
    }
  }
  flush();
  if (hunks.length === 0) throw new Error("Update 没有 hunk");

  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.oldLines.length === 0) {
      current.splice(cursor, 0, ...hunk.newLines);
      cursor += hunk.newLines.length;
      continue;
    }
    let found = -1;
    for (let i = cursor; i <= current.length - hunk.oldLines.length; i++) {
      if (hunk.oldLines.every((line, j) => current[i + j] === line)) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      throw new Error(`找不到 hunk 对应的旧内容（从第 ${cursor + 1} 行起）`);
    }
    current.splice(found, hunk.oldLines.length, ...hunk.newLines);
    cursor = found + hunk.newLines.length;
  }
  const next = current.join("\n");
  return crlf ? next.replace(/\n/g, "\r\n") : next;
}
