import { describe, expect, it } from "vitest";
import { runAcceptance, scriptedLlmFor } from "../src/acceptance.js";

describe("P1 验收（scripted 自检，§9）", () => {
  it("10 个任务全部通过", async () => {
    const report = await runAcceptance(scriptedLlmFor, "scripted");
    const failed = report.results.filter((r) => !r.pass);
    expect(failed.map((r) => `${r.id}: ${r.details}`)).toEqual([]);
    expect(report.passed).toBe(report.total);
    expect(report.total).toBe(10);
  }, 120_000);
});
