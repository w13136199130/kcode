import { describe, expect, it } from "vitest";
import { formatCostUsage } from "../src/tui/input/cost.js";

/** 3-21：/cost 分项展示（缓存/推理/按模型/按工具，未知厂商降级） */
describe("formatCostUsage", () => {
  it("完整分项：缓存、推理、按模型、按工具", () => {
    const text = formatCostUsage(
      {
        inputTokens: 1_000,
        outputTokens: 200,
        calls: 3,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        reasoningTokens: 50,
        byModel: {
          "glm/glm-5": { inputTokens: 1_000, outputTokens: 200, calls: 3, cacheReadTokens: 600, reasoningTokens: 50 },
        },
        byTool: { bash: 2, read: 1 },
        subagents: { count: 1, inputTokens: 40, outputTokens: 8 },
      },
      "GLM-5",
    );
    expect(text).toContain("缓存命中 600 · 写入 100");
    expect(text).toContain("推理 50");
    expect(text).toContain("按模型：");
    expect(text).toContain("glm/glm-5");
    expect(text).toContain("工具调用（3 次）：bash 2 · read 1");
    expect(text).toContain("子代理（1 个）：输入 40 tok · 输出 8 tok（主会话合计之外）");
    expect(text).toContain("当前模型 GLM-5");
  });

  it("未知厂商未回报分项：降级提示，不显示假 0", () => {
    const text = formatCostUsage({ inputTokens: 10, outputTokens: 2, calls: 1 }, "m");
    expect(text).toContain("该厂商未回报缓存/推理分项");
    expect(text).not.toContain("缓存命中 0");
  });

  it("端点完全未回报用量：仅调用次数", () => {
    const text = formatCostUsage({ inputTokens: 0, outputTokens: 0, calls: 2 }, "m");
    expect(text).toContain("端点未回报用量");
  });

  it("续接历史无 byModel：提示分项从本进程开始", () => {
    const text = formatCostUsage({ inputTokens: 10, outputTokens: 2, calls: 2 }, "m");
    expect(text).toContain("分项从本进程开始累计");
  });
});
