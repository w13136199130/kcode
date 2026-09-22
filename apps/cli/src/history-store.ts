import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 输入历史持久化（B4）：~/.kcode/cli/history.json，最近 200 条去重连续项。
 * 内存展示仍取最近 50 条（InputBox 历史翻阅）。
 */
const HISTORY_FILE = join(homedir(), ".kcode", "cli", "history.json");
const MAX_STORED = 200;

export async function loadInputHistory(file: string = HISTORY_FILE): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      return raw.filter((v): v is string => typeof v === "string").slice(-MAX_STORED);
    }
  } catch {
    // 文件缺失/损坏按空处理
  }
  return [];
}

export async function saveInputHistory(entries: string[], file: string = HISTORY_FILE): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(entries.slice(-MAX_STORED), null, 0)}\n`, "utf8");
  } catch {
    // 持久化失败不影响会话
  }
}

/** 追加一条（跳过与上一条相同的连续输入），返回新数组 */
export function appendHistory(entries: string[], text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "" || entries[entries.length - 1] === trimmed) {
    return entries;
  }
  return [...entries, trimmed].slice(-MAX_STORED);
}
