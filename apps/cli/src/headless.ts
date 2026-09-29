import type { PermissionMode } from "@kcode/contracts";
import { jsonlLine } from "@kcode/shared";
import type { Runtime } from "./bootstrap.js";
import { createSession } from "./session.js";

/**
 * 无 TUI 单次运行（N3C-1）：--json 或"非 TTY 且带提问"时走此路径，不渲染 Ink。
 * stdout 只输出 NDJSON（--json）或一行人话摘要——脚本/CI 可直接管道解析。
 * 事件复用 SessionEvent + jsonlLine（与 JSONL 落盘同构），不发明第二套 schema；
 * 权限语义：无 asker 时 ask 自动降级 deny（pipeline 既有规则），即 headless 的
 * default 档 = 只读自主 + 写类拒绝，与 zcode 的 --mode 默认行为一致。
 */

export interface HeadlessOptions {
  prompt: string;
  images?: string[];
  mode?: PermissionMode;
  disallowedTools?: string[];
  resumeFrom?: string;
  json: boolean;
}

/** 结束码对齐常见 CLI 惯例：成功 0、失败 1、中断 130（SIGINT 语义） */
function exitCodeFor(status: string): number {
  if (status === "completed") return 0;
  if (status === "aborted") return 130;
  return 1;
}

export async function runHeadless(
  runtime: Runtime,
  model: string,
  opts: HeadlessOptions,
  write: (line: string) => void,
): Promise<number> {
  const session = await createSession({
    runtime,
    model,
    cwd: process.cwd(),
    resumeFrom: opts.resumeFrom,
    initialMode: opts.mode,
    disallowedTools: opts.disallowedTools,
    onEvent: opts.json ? (event) => write(jsonlLine(event)) : undefined,
  });
  try {
    const summary = await session.loop.run(
      opts.prompt,
      opts.images !== undefined ? { images: opts.images } : {},
    );
    if (opts.json) {
      // 末行是 CLI 级汇总记录：type=result 与 SessionEvent 的 type 联合区分，
      // 消费方读到 type==="result" 即为终点
      write(
        jsonlLine({
          type: "result",
          status: summary.status,
          sessionId: summary.sessionId,
          turns: summary.turns,
          toolCalls: summary.toolCalls,
        }),
      );
    } else {
      const mark = summary.status === "completed" ? "✓" : "✗";
      write(`${mark} ${summary.status} · ${summary.turns} turns · ${summary.toolCalls} tool calls · ${summary.sessionId}`);
    }
    return exitCodeFor(summary.status);
  } finally {
    await session.close();
  }
}
