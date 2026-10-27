import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * S1-1（F4）：导出会话 JSONL（与 CLI /export 同语义：原样转写文件）。
 * 走 readFile→writeFile 而非 copyFile：Windows 上 Defender 对新写文件的
 * 实时扫描锁会让 CopyFileW 报 EPERM，共享读的 readFile 不受影响。
 * 目标已存在时追加序号，不静默覆盖。
 */
export async function exportSessionFile(
  sessionsDir: string,
  sessionId: string,
  targetDir: string,
): Promise<{ path: string }> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("会话 id 非法");
  if (targetDir.trim() === "") throw new Error("导出目录不能为空");
  const source = join(sessionsDir, `${sessionId}.jsonl`);
  const text = await readFile(source, "utf8").catch(() => {
    throw new Error(`会话 ${sessionId} 不存在或不可读`);
  });
  let target = join(targetDir, `${sessionId}.jsonl`);
  for (let n = 1; ; n += 1) {
    const exists = await access(target).then(
      () => true,
      () => false,
    );
    if (!exists) break;
    if (n > 99) throw new Error("导出目标目录里同名文件过多");
    target = join(targetDir, `${sessionId}-${n}.jsonl`);
  }
  await writeFile(target, text, "utf8");
  return { path: target };
}
