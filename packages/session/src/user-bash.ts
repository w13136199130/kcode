import { join } from "node:path";
import { createBashTool } from "@kcode/tools";

/**
 * !命令 用户直执行（自 composition 外迁，N2-5 拆分）：
 * 不经 LLM、不问权限，独立 bash 实例（artifacts 隔离），结果仅返回显示。
 */
export async function runUserBash(
  command: string,
  timeoutMs: number | undefined,
  opts: {
    sessionId: string;
    kcodeHomeDir: string;
    cwd: string;
    onNotice?: (message: string) => void;
  },
): Promise<{ ok: boolean; output: string; error?: string; durationMs: number }> {
  const bash = createBashTool({
    sessionId: `${opts.sessionId}-user`,
    artifactsDir: join(opts.kcodeHomeDir, "cli", "artifacts", `${opts.sessionId}-user`),
    onNotice: opts.onNotice,
  });
  const started = Date.now();
  const result = await bash.execute(
    { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    { sessionId: opts.sessionId, cwd: opts.cwd },
  );
  return {
    ok: result.ok,
    output: result.output,
    ...(result.error !== undefined ? { error: result.error } : {}),
    durationMs: Date.now() - started,
  };
}
