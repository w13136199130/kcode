import { exportCommand } from "./export-command.js";
import { sessionsCommand } from "./sessions-command.js";

/** 3-04/3-06：sessions/export 共用的数据子命令入口 */
export async function runDataCommand(
  kind: "sessions" | "export",
  cwd: string,
  kcodeHomeDir: string,
  args: string[],
  write: (line: string) => void,
): Promise<boolean> {
  return kind === "sessions"
    ? sessionsCommand(cwd, kcodeHomeDir, args, write)
    : exportCommand(cwd, kcodeHomeDir, args, write);
}
