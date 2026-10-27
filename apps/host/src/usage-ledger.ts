import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * S2-6 第一片（S1-6 消费）：跨会话用量账本（只读估算版）。
 * 事实源是各会话 JSONL 尾部的 session_end.usage（append-only，一轮一条）；
 * 为避免整读大文件，每文件只读头部 4KB（session_start.model）+ 尾部 64KB（全部可见的
 * session_end）——超大转写的中段轮次可能漏计，UI 必须标注「按转写尾部估算」。
 */
export interface UsageLedger {
  approximate: true;
  sessions: number;
  totals: { inputTokens: number; outputTokens: number; calls: number };
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number; calls: number }>;
}

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

async function readSlice(path: string, start: number, length: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fh.read({ buffer, position: start });
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function usageLedger(sessionsDir: string): Promise<UsageLedger> {
  const files = (await readdir(sessionsDir).catch(() => []))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionsDir, name));
  const byModel = new Map<string, ModelUsage>();
  let sessions = 0;
  let inputTotal = 0;
  let outputTotal = 0;
  let callsTotal = 0;

  for (const file of files) {
    const { size } = await open(file).then(async (fh) => {
      const st = await fh.stat();
      await fh.close();
      return st;
    });
    const head = await readSlice(file, 0, Math.min(size, 4096));
    const model = /"type":"session_start"[^}]*?"model":"([^"]+)"/.exec(head)?.[1] ?? "(未知模型)";
    const tailStart = Math.max(0, size - 65536);
    const tail = await readSlice(file, tailStart, size - tailStart);
    const endLines = tail.split("\n").filter((line) => line.includes('"type":"session_end"'));
    if (endLines.length === 0) continue;
    sessions += 1;
    let modelUsage = byModel.get(model);
    if (modelUsage === undefined) {
      modelUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
      byModel.set(model, modelUsage);
    }
    for (const line of endLines) {
      try {
        const usage = (JSON.parse(line) as { usage?: ModelUsage }).usage;
        if (usage === undefined) continue;
        modelUsage.inputTokens += usage.inputTokens;
        modelUsage.outputTokens += usage.outputTokens;
        modelUsage.calls += usage.calls ?? 0;
        inputTotal += usage.inputTokens;
        outputTotal += usage.outputTokens;
        callsTotal += usage.calls ?? 0;
      } catch {
        // 半行/损坏行跳过（估算语义）
      }
    }
  }

  return {
    approximate: true,
    sessions,
    totals: { inputTokens: inputTotal, outputTokens: outputTotal, calls: callsTotal },
    byModel: [...byModel.entries()]
      .map(([model, usage]) => ({ model, ...usage }))
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
  };
}
