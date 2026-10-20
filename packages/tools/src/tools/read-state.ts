import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { ToolContext } from "@kcode/contracts";

/** 3-09：读后状态在组合层按会话持有；独立工具测试没有 ctx.reads 时不启用校验 */
function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function recordRead(ctx: ToolContext, abs: string, content: string): Promise<void> {
  if (ctx.reads === undefined) return;
  const st = await stat(abs).catch(() => null);
  ctx.reads.set(abs, {
    hash: contentHash(content),
    mtimeMs: st?.mtimeMs ?? 0,
    size: st?.size ?? Buffer.byteLength(content),
  });
}

/**
 * 写/编辑前校验：必须读过，且 read 后内容未变。
 * 返回 undefined = 通过；字符串 = 拒绝原因。
 */
export function verifyReadBeforeWrite(
  ctx: ToolContext,
  abs: string,
  currentContent: string,
): string | undefined {
  if (ctx.reads === undefined) return undefined;
  const previous = ctx.reads.get(abs);
  if (previous === undefined) {
    return `文件 ${abs} 尚未读取：请先用 read 读取，再进行写/编辑`;
  }
  if (contentHash(currentContent) !== previous.hash) {
    return `文件 ${abs} 在 read 后已被修改：请重新 read 后再写/编辑，避免覆盖外部改动`;
  }
  return undefined;
}
