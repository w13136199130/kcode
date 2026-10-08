import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 原子写文本文件（N3I-1）：同目录临时文件 + rename 原子替换。
 * 中断/崩溃语义：目标文件要么旧内容要么完整新内容，不会半截——
 * Esc 中断或进程崩溃落在 rename 前则临时文件被丢弃，落在后则已完成。
 * - 继承原文件 mode（保执行位；新建文件 0o666 走 umask）
 * - 写后 fsync（断电语义）
 * - 任一步失败清理临时文件并降级直接写（rename 受阻的兜底，目标可能半截——
 *   比起整笔失败，宁可完成写入；调用方 error 通道仍会拿到异常）
 */
export async function atomicWriteText(abs: string, content: string): Promise<void> {
  const dir = dirname(abs);
  const tmp = join(dir, `.${basename(abs)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  let inheritedMode: number | undefined;
  try {
    inheritedMode = (await stat(abs)).mode & 0o777;
  } catch {
    // 目标不存在——新建
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dir, { recursive: true });
    handle = await open(tmp, "w", inheritedMode ?? 0o666);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, abs);
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await unlink(tmp).catch(() => {});
    await mkdir(dir, { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}
