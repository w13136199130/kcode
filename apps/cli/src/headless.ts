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
  // -p 非 --json：onDelta 直写 stdout（微缓冲）；--json 保持纯 NDJSON 通道
  const streamer = opts.json ? undefined : new DeltaWriter(writeRaw);
  const session = await createSession({
    runtime,
    model,
    cwd: process.cwd(),
    resumeFrom: opts.resumeFrom,
    initialMode: opts.mode,
    disallowedTools: opts.disallowedTools,
    onEvent: opts.json ? (event) => write(jsonlLine(event)) : undefined,
    onDelta: streamer !== undefined ? (delta) => streamer.push(delta) : undefined,
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
      // 先冲刷再分支：正文若还在微缓冲里（<64B 且未满 50ms），此刻必须落盘
      streamer?.flush();
      if (streamer !== undefined && streamer.streamed) {
        // 流式模式：正文已逐段写出，末尾换行收尾不重复摘要（状态经退出码传达）
        streamer.endNewline();
      } else {
        const mark = summary.status === "completed" ? "✓" : "✗";
        write(`${mark} ${summary.status} · ${summary.turns} turns · ${summary.toolCalls} tool calls · ${summary.sessionId}`);
      }
    }
    return exitCodeFor(summary.status);
  } finally {
    await session.close();
  }
}
