import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `#` 快捷记忆（N3G-3，对标 CC #）：追加一行到项目级 AGENTS.md——与
 * loadAgentsMd 同源（composition 启动时装载），即下次会话生效、不进本轮上下文。
 * 模块自治：InputArea 的 onSubmit 包装层拦截后调用，不经 App（行数红线）。
 */

/** 追加一行（空行分隔）；文件不存在则创建。返回写入路径。 */
export async function appendMemoryLine(cwd: string, line: string): Promise<string> {
  const path = join(cwd, "AGENTS.md");
  let prev = "";
  try {
    prev = await readFile(path, "utf8");
  } catch {
    // 不存在即新建
  }
  const body =
    prev === ""
      ? `${line}\n`
      : `${prev}${prev.endsWith("\n") ? (prev.endsWith("\n\n") ? "" : "\n") : "\n\n"}${line}\n`;
  await writeFile(path, body, "utf8");
  return path;
}
