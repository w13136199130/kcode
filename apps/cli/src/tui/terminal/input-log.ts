import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 输入事件调试日志：设 KCODE_INPUT_DEBUG=1 后写入 ~/kcode-input.log（排查终端差异用） */
export function appendInputLog(line: string): void {
  try {
    appendFileSync(join(homedir(), "kcode-input.log"), `${Date.now()} ${line}\n`, "utf8");
  } catch {
    // 调试日志失败静默
  }
}
