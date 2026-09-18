import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionEvent, SessionSink } from "@kcode/contracts";
import { jsonlLine } from "@kcode/shared";

/** JSONL append-only 落盘（ADR-7）：runtime 实现 SessionSink 端口，daemon 注入 core */
export class JsonlSessionSink implements SessionSink {
  private constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonlSessionSink> {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, "");
    return new JsonlSessionSink(filePath);
  }

  async append(event: SessionEvent): Promise<void> {
    await appendFile(this.filePath, jsonlLine(event));
  }
}
