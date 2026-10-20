import type { PermissionMode, SessionEvent } from "@kcode/contracts";
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
  /** 兼容入口：true 等价 outputFormat=stream-json */
  json: boolean;
  /** 2-12：text | json（单条 result） | stream-json（事件流 + result） */
  outputFormat?: "text" | "json" | "stream-json";
  maxTurns?: number;
  ephemeral?: boolean;
  sessionId?: string;
}

/**
 * 2-11 退出码契约：0 成功 / 1 通用失败 / 2 参数配置 / 3 认证 / 4 模型 API / 130 中断。
 * 认证与模型 API 只能从 llm_error 文本归类（provider 层没有结构化错误码）。
 */
function exitCodeFor(status: string, events: readonly SessionEvent[]): number {
  if (status === "aborted") return 130;
  if (status === "completed") return 0;
  const error = [...events]
    .reverse()
    .find((e): e is Extract<SessionEvent, { type: "llm_error" }> => e.type === "llm_error")
    ?.error;
  if (error === undefined) return 1;
  if (/(401|403|unauthori[sz]ed|invalid[^\n]*key|keychain|KCODE_KEYCHAIN|认证|鉴权)/i.test(error)) return 3;
  if (/(未配置|请先.*配置|config)/i.test(error)) return 2;
  if (/(429|5\d\d|timeout|timed out|ECONN|ENOTFOUND|fetch failed|模型|provider)/i.test(error)) return 4;
  return 1;
}

/**
 * 流式增量微缓冲（N3F-7）：逐 token 直写 stdout 会造成系统调用抖动——
 * 攒到 64 字节或 50ms 先到者即冲刷。导出便于单测（fake timers）。
 */
export class DeltaWriter {
  readonly #write: (s: string) => void;
  readonly #maxBytes: number;
  readonly #intervalMs: number;
  #buf = "";
  #timer: NodeJS.Timeout | undefined;
  #lastChar = "";
  /** 是否已冲刷过正文（决定收尾行为：流式不重复摘要） */
  streamed = false;

  constructor(write: (s: string) => void, maxBytes = 64, intervalMs = 50) {
    this.#write = write;
    this.#maxBytes = maxBytes;
    this.#intervalMs = intervalMs;
  }

  push(delta: string): void {
    if (delta === "") {
      return;
    }
    this.#buf += delta;
    if (Buffer.byteLength(this.#buf, "utf8") >= this.#maxBytes) {
      this.flush();
      return;
    }
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.flush(), this.#intervalMs);
      this.#timer.unref(); // 不拖进程退出
    }
  }

  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#buf !== "") {
      this.#lastChar = this.#buf.at(-1) ?? "";
      this.streamed = true;
      this.#write(this.#buf);
      this.#buf = "";
    }
  }

  /** 收尾换行：正文末字符已是换行则不再补（避免空行） */
  endNewline(): void {
    if (this.streamed && this.#lastChar !== "\n") {
      this.#write("\n");
    }
  }
}

export async function runHeadless(
  runtime: Runtime,
  model: string,
  opts: HeadlessOptions,
  write: (line: string) => void,
  /** 流式增量原始写通道（不加换行——正文必须连续）；缺省复用 write（测试收集器语义一致） */
  writeRaw: (chunk: string) => void = write,
): Promise<number> {
  const format = opts.outputFormat ?? (opts.json ? "stream-json" : "text");
  // text：onDelta 直写 stdout（微缓冲）；json/stream-json 保持纯 NDJSON 通道
  const streamer = format === "text" ? new DeltaWriter(writeRaw) : undefined;
  const events: SessionEvent[] = [];
  const session = await createSession({
    runtime,
    model,
    cwd: process.cwd(),
    resumeFrom: opts.resumeFrom,
    initialMode: opts.mode,
    disallowedTools: opts.disallowedTools,
    maxTurns: opts.maxTurns,
    ephemeral: opts.ephemeral,
    sessionId: opts.sessionId,
    onEvent: (event) => {
      // 3-10：进度是前端专用，不进入 headless 的事件流/NDJSON 契约
      if (event.type === "tool_progress") return;
      events.push(event);
      if (format === "stream-json") write(jsonlLine(event));
    },
    onDelta: streamer !== undefined ? (delta) => streamer.push(delta) : undefined,
  });
  try {
    const summary = await session.loop.run(
      opts.prompt,
      opts.images !== undefined ? { images: opts.images } : {},
    );
    const permissionDenials = events.filter(
      (e) =>
        e.type === "permission_decision" &&
        (e.decision === "deny" || e.decision === "ask-denied"),
    ).length;
    const toolFailures = events.filter(
      (e) => e.type === "tool_result" && !e.ok,
    ).length;
    const usage = (await session.usage()) ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
    // 2-11：有权限拒绝时不能报“成功”——CI 会把假绿当通过
    const status = summary.status === "completed" && permissionDenials > 0 ? "failed" : summary.status;
    const result = {
      type: "result" as const,
      status,
      sessionId: summary.sessionId,
      turns: summary.turns,
      toolCalls: summary.toolCalls,
      permissionDenials,
      toolFailures,
      usage,
    };
    if (format === "json" || format === "stream-json") {
      // 末行是 CLI 级汇总记录：type=result 与 SessionEvent 的 type 联合区分，
      // 消费方读到 type==="result" 即为终点；json 模式只有这一行
      write(jsonlLine(result));
    } else {
      // 先冲刷再分支：正文若还在微缓冲里（<64B 且未满 50ms），此刻必须落盘
      streamer?.flush();
      if (streamer !== undefined && streamer.streamed) {
        // 流式模式：正文已逐段写出，末尾换行收尾不重复摘要（状态经退出码传达）
        streamer.endNewline();
      } else {
        const mark = status === "completed" ? "✓" : "✗";
        write(
          `${mark} ${status} · ${summary.turns} turns · ${summary.toolCalls} tool calls · ${summary.sessionId}` +
            (permissionDenials > 0 ? ` · ${permissionDenials} permission denied` : "") +
            (toolFailures > 0 ? ` · ${toolFailures} tool failures` : ""),
        );
      }
    }
    return exitCodeFor(status, events);
  } finally {
    await session.close();
  }
}
