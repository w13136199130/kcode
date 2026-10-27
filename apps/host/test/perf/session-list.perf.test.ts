import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { SessionSummaryCache } from "../../src/session-summaries.js";

const enabled = process.env["KCODE_PERF"] === "1";
const perfTest = enabled ? test : test.skip;

const SESSION_COUNT = 200;
const LARGE_COUNT = 3;
const LARGE_BYTES = 5 * 1024 * 1024;
const WORKSPACE = "E:/space/perf";

function jsonl(events: Array<Record<string, unknown>>): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kcode-perf-sessions-"));
  await mkdir(dir, { recursive: true });
  const writes: Promise<void>[] = [];
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = `sess_perf_${String(i).padStart(3, "0")}`;
    const ts = Date.now() - i * 1_000;
    const large = i < LARGE_COUNT;
    const assistant = large
      ? "x".repeat(LARGE_BYTES)
      : `完成 ${i}`;
    const content = jsonl([
      { v: 1, type: "session_start", ts, sessionId: id, model: "mock/model", workspaceKey: WORKSPACE },
      { v: 1, type: "user_message", ts: ts + 1, sessionId: id, content: large ? `大会话 ${i}` : `任务 ${i}` },
      { v: 1, type: "assistant_message", ts: ts + 2, sessionId: id, content: assistant },
    ]);
    writes.push(writeFile(join(dir, `${id}.jsonl`), content, "utf8"));
    if (i % 20 === 0) writes.push(writeFile(join(dir, `${id}.title`), `标题 ${i}`, "utf8"));
  }
  await Promise.all(writes);
  return dir;
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function measure(list: () => Promise<unknown>, count: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await list();
    samples.push(performance.now() - start);
  }
  return samples;
}

perfTest("sessions/list 200 会话冷/热 P95 < 50ms", { timeout: 180_000 }, async () => {
  const dir = await fixture();
  try {
    const coldSamples: number[] = [];
    let lastColdReads = 0;
    for (let i = 0; i < 20; i++) {
      const cache = new SessionSummaryCache(dir);
      const start = performance.now();
      const rows = await cache.list();
      coldSamples.push(performance.now() - start);
      expect(rows).toHaveLength(SESSION_COUNT);
      lastColdReads = cache.headReads;
      // 缓存命中后不应再读文件头。
      const reads = cache.headReads;
      await cache.list();
      expect(cache.headReads).toBe(reads);
    }
    expect(lastColdReads).toBe(SESSION_COUNT);

    const warm = new SessionSummaryCache(dir);
    await warm.list();
    const warmSamples = await measure(() => warm.list(), 30);

    const coldP95 = p95(coldSamples);
    const warmP95 = p95(warmSamples);
    process.stdout.write(
      `[perf] cold p95=${coldP95.toFixed(2)}ms samples=${coldSamples.map((n) => n.toFixed(1)).join(",")}\n`,
    );
    process.stdout.write(
      `[perf] warm p95=${warmP95.toFixed(2)}ms samples=${warmSamples.map((n) => n.toFixed(1)).join(",")}\n`,
    );
    expect(coldP95).toBeLessThan(50);
    expect(warmP95).toBeLessThan(50);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});
