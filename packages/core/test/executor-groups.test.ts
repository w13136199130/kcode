import { describe, expect, it } from "vitest";
import type { Tool } from "@kcode/contracts";
import type { ToolPipeline } from "../src/core/pipeline.js";
import { TurnExecutor, type PendingCall } from "../src/core/executor.js";

/**
 * 执行器并行组（N3D-1）：并行工具（readOnly 或 concurrentSafe）成组并发、
 * 非并行工具单例组、组间顺序；结果按原调用顺序回填；失败不截断后续组。
 * 用时间窗重叠断言并发性（60ms 延迟 × 相邻启动 < 60ms 即并发）。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Span {
  tool: string;
  start: number;
  end: number;
}

function makeHarness(defs: Array<{ name: string; readOnly?: boolean; concurrentSafe?: boolean; fail?: boolean }>) {
  const spans: Span[] = [];
  const now = Date.now();
  const pipeline = {
    run: async (tool: Tool): Promise<{ ok: boolean; output: string; error?: string }> => {
      const start = Date.now() - now;
      await sleep(60);
      spans.push({ tool: tool.definition.name, start, end: Date.now() - now });
      return defs.find((d) => d.name === tool.definition.name)?.fail
        ? { ok: false, output: "", error: "失败" }
        : { ok: true, output: tool.definition.name };
    },
  } as unknown as ToolPipeline;
  const tools: Tool[] = defs.map((d) => ({
    definition: {
      name: d.name,
      description: "",
      parameters: { type: "object", properties: {} },
      readOnly: d.readOnly === true,
      ...(d.concurrentSafe !== undefined ? { concurrentSafe: d.concurrentSafe } : {}),
    },
    execute: async () => ({ ok: true, output: "" }),
  }));
  return { executor: new TurnExecutor(pipeline, () => Date.now()), tools, spans };
}

const calls = (names: string[]): PendingCall[] => names.map((n, i) => ({ callId: `c${i}`, tool: n, args: {} }));

const overlap = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

describe("TurnExecutor 并行组（N3D-1）", () => {
  it("读写混合：连续读并发、写独占单例组、组间顺序、结果保持原序", async () => {
    const { executor, tools, spans } = makeHarness([
      { name: "readA", readOnly: true },
      { name: "readB", readOnly: true },
      { name: "writeC" },
      { name: "readD", readOnly: true },
    ]);
    const results = await executor.executeCalls(calls(["readA", "readB", "writeC", "readD"]), tools);
    expect(results.map((r) => r.result.output)).toEqual(["readA", "readB", "writeC", "readD"]);
    const by = (n: string): Span => spans.find((s) => s.tool === n)!;
    expect(overlap(by("readA"), by("readB"))).toBe(true); // 相邻读进同一并行组
    expect(by("writeC").start).toBeGreaterThanOrEqual(by("readA").end); // 写在组后
    expect(by("readD").start).toBeGreaterThanOrEqual(by("writeC").end); // 后续读再成组
  });

  it("concurrentSafe 声明覆盖 readOnly 推导：多个 task（子代理）fan-out 并发", async () => {
    const { executor, tools, spans } = makeHarness([
      { name: "task1", concurrentSafe: true },
      { name: "task2", concurrentSafe: true },
    ]);
    await executor.executeCalls(calls(["task1", "task2"]), tools);
    expect(overlap(spans[0]!, spans[1]!)).toBe(true);
  });

  it("未声明 concurrentSafe 的写工具批内串行", async () => {
    const { executor, tools, spans } = makeHarness([{ name: "w1" }, { name: "w2" }]);
    await executor.executeCalls(calls(["w1", "w2"]), tools);
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end);
  });

  it("单组失败不截断后续组（对标 zcode 已废弃策略的教训）", async () => {
    const { executor, tools } = makeHarness([
      { name: "badWrite", fail: true },
      { name: "readAfter", readOnly: true },
    ]);
    const results = await executor.executeCalls(calls(["badWrite", "readAfter"]), tools);
    expect(results[0]!.result.ok).toBe(false);
    expect(results[1]!.result.ok).toBe(true);
  });

  it("预中断：未开始的调用按取消结算", async () => {
    const { executor, tools, spans } = makeHarness([{ name: "readA", readOnly: true }]);
    const controller = new AbortController();
    controller.abort();
    const results = await executor.executeCalls(calls(["readA"]), tools, controller.signal);
    expect(results[0]!.result.ok).toBe(false);
    expect(results[0]!.result.error).toContain("aborted");
    expect(spans).toHaveLength(0);
  });
});
