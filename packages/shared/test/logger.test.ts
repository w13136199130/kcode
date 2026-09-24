import { describe, expect, it } from "vitest";
import { createServiceLogger, type LogSink } from "../src/logger.js";

describe("createServiceLogger", () => {
  it("按 scope 前缀分级输出", () => {
    const calls: string[] = [];
    const sink: Partial<LogSink> = {
      debug: (m, ...a) => calls.push(`debug:${m}:${a.join(",")}`),
      info: (m, ...a) => calls.push(`info:${m}:${a.join(",")}`),
      warn: (m, ...a) => calls.push(`warn:${m}:${a.join(",")}`),
      error: (m, ...a) => calls.push(`error:${m}:${a.join(",")}`),
    };
    const log = createServiceLogger("test.scope", { sink, debugEnabled: true });
    log.info("hello", "x");
    log.warn("careful");
    log.error("boom");
    log.debug("trace");
    expect(calls).toEqual([
      "info:[test.scope]:hello,x",
      "warn:[test.scope]:careful",
      "error:[test.scope]:boom",
      "debug:[test.scope]:trace",
    ]);
  });

  it("debug 默认关闭：debugEnabled=false 不输出 debug", () => {
    const seen: unknown[] = [];
    const log = createServiceLogger("s", { sink: { debug: (m) => seen.push(m) }, debugEnabled: false });
    log.debug("hidden");
    expect(seen).toHaveLength(0);
  });
});
