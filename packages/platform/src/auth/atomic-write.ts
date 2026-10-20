import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 2-18：keychain 原子写。
 * tmp → 备份旧文件 → rename；崩溃时旧文件/`.bak` 至少留一份，不出现半截 JSON。
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  try {
    await copyFile(path, `${path}.bak`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(tmp, { force: true });
      throw err;
    }
    // Windows 某些文件系统不覆盖目标：备份已存在，删旧再 rename
    await rm(path, { force: true });
    await rename(tmp, path);
  }
}
