import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditRecord, AuditSink } from "@kcode/core";

/**
 * 3-29：审计落盘（独立于会话 JSONL）。
 * 每会话一个追加文件，路径由组合层传入（固定 `<kcodeHome>/cli/audit/<sessionId>.jsonl`）。
 *
 * 设计：
 * - 串行化写入：audit 调用是同步 fire-and-forget，内部用 Promise 链保证行序；
 * - 写失败只告警一次，不阻断会话（审计可用性不等于执行可用性）；
 * - close() 等待队列排空，退出前不丢最后几条；
 * - 内容为一行一条 JSON，包含工具/裁决/scope/耗时/cwd/权限档/父会话。
 */
export interface FileAuditSink {
  path: string;
  sink: AuditSink;
  close(): Promise<void>;
}

export async function openFileAuditSink(path: string, onWarn?: (message: string) => void): Promise<FileAuditSink> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let warned = false;

  const sink: AuditSink = (record: AuditRecord) => {
    if (closed) {
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    chain = chain.then(() =>
      appendFile(path, line, { encoding: "utf8", mode: 0o600 }).catch((err: unknown) => {
        if (!warned) {
          warned = true;
          onWarn?.(`审计日志写入失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  };

  return {
    path,
    sink,
    close: async () => {
      closed = true;
      await chain;
    },
  };
}
