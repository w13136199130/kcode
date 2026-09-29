import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 外部编辑器（N3C-4④）：Ctrl+E 把当前输入放进 $EDITOR 编辑，保存退出后回填输入框。
 * spawnSync 会阻塞事件循环——调用方必须确保仅在空闲（非 busy）时进入，
 * 否则流式渲染与计时器全部冻结；编辑期间由调用方关闭 raw mode，终端交还编辑器。
 * EDITOR 形态支持 "code -w" / "vim"（首段命令 + 参数）；未设置时按平台给 notepad/vi 兜底。
 */

export type EditorResult = { ok: true; text: string } | { ok: false; error: string };

/** 解析 EDITOR 环境变量：允许带参数的多段命令 */
function editorCommand(): { cmd: string; args: string[] } {
  const raw = process.env["EDITOR"] ?? (process.platform === "win32" ? "notepad" : "vi");
  const parts = raw.split(/\s+/).filter((s) => s !== "");
  return { cmd: parts[0] ?? raw, args: parts.slice(1) };
}

export async function openInExternalEditor(
  initial: string,
  hooks: { suspend(): void; resume(): void },
): Promise<EditorResult> {
  const file = join(tmpdir(), `kcode-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  await writeFile(file, initial, "utf8");
  hooks.suspend();
  try {
    const { cmd, args } = editorCommand();
    const result = spawnSync(cmd, [...args, file], { stdio: "inherit" });
    if (result.error !== undefined) {
      return {
        ok: false,
        error: `无法启动编辑器「${cmd}」：${result.error.message}——可用 EDITOR 环境变量指定（如 EDITOR="code -w"）`,
      };
    }
    // 统一换行并去掉编辑器惯例留下的末尾空行；空文件 = 放弃编辑，保持原输入
    const text = (await readFile(file, "utf8")).replace(/\r\n/g, "\n").replace(/\n+$/, "");
    return { ok: true, text: text === "" ? initial : text };
  } finally {
    hooks.resume();
    await rm(file, { force: true });
  }
}
