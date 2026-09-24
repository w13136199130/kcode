import { describe, expect, it } from "vitest";
import { SessionRunner } from "../src/session/runner.js";

describe("SessionRunner", () => {
  it("同步取得互斥锁；取消后直到工作退出前仍拒绝新运行；旧 ID 不取消新任务", async () => {
    const runner = new SessionRunner();
    let finish!: () => void;
    let signal!: AbortSignal;
    const first = runner.start(async (s) => {
      signal = s;
      await new Promise<void>((resolve) => { finish = resolve; });
    }, "first");
    expect(() => runner.start(async () => {})).toThrow("正在运行");
    await Promise.resolve();
    expect(runner.abort("wrong")).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(runner.abort("first")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(() => runner.start(async () => {})).toThrow("正在运行");
    finish(); await first.result;
    const second = runner.start(async (s) => expect(s.aborted).toBe(false), "second");
    expect(runner.abort("first")).toBe(false);
    await second.result;
    expect(runner.busy).toBe(false);
  });

  it("异常释放锁，两个会话互不影响", async () => {
    const a = new SessionRunner(); const b = new SessionRunner();
    const failed = a.start(async () => { throw new Error("failed"); });
    const other = b.start(async (signal) => expect(signal.aborted).toBe(false));
    a.abort();
    await expect(failed.result).rejects.toThrow("failed");
    await other.result;
    expect(a.busy).toBe(false);
    await a.start(async () => "ok").result;
  });
});
