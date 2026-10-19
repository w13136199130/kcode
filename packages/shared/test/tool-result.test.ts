import { describe, expect, it } from "vitest";
import { formatToolResultForModel } from "../src/index.js";

describe("formatToolResultForModel", () => {
  it("成功时原样返回 output", () => {
    expect(formatToolResultForModel({ ok: true, output: "done" })).toBe("done");
  });

  it("失败但有 output 时把错误前置（exit code 不能丢）", () => {
    expect(
      formatToolResultForModel({ ok: false, output: "2 tests failed", error: "exit code 1" }),
    ).toBe("[失败] exit code 1\n2 tests failed");
  });

  it("失败且 output 为空时不重复拼接错误", () => {
    expect(formatToolResultForModel({ ok: false, output: "", error: "permission denied (ask)" })).toBe(
      "[失败] permission denied (ask)",
    );
  });

  it("失败且没有错误文本时也明确标注失败", () => {
    expect(formatToolResultForModel({ ok: false, output: "" })).toBe("[失败]");
  });
});
