import { describe, expect, it } from "vitest";
import { contextItems } from "../src/index.js";

import type { Tool } from "@kcode/contracts";

const tool = (name: string, schema: unknown): Tool =>
  ({ definition: { name, description: "示例工具说明", parameters: schema } }) as unknown as Tool;

/** S3-2：注入项条目化（/context 预算表与桌面 tooltip 的共同数据源）。 */
describe("contextItems（S3-2）", () => {
  it("内建工具与 MCP 服务器分组：mcp__<server>__ 前缀各自成条，含工具数", () => {
    const items = contextItems(
      "系统提示词",
      [
        tool("read", { type: "object" }),
        tool("bash", { type: "object" }),
        tool("mcp__fs__list_files", { type: "object" }),
        tool("mcp__fs__read_file", { type: "object" }),
        tool("mcp__web__search", { type: "object" }),
      ],
      1200,
    );
    expect(items.map((item) => item.label)).toEqual(["系统提示", "内建工具定义", "MCP·fs", "MCP·web", "历史消息"]);
    const fs = items.find((item) => item.label === "MCP·fs");
    expect(fs?.detail).toBe("2 个工具");
    expect(items.find((item) => item.label === "内建工具定义")?.detail).toBe("2 个");
    expect(items.at(-1)?.tokens).toBe(1200);
  });

  it("MCP 条目按 token 降序排列（贵的先看见）", () => {
    const items = contextItems("s", [tool("mcp__small__a", 1), tool("mcp__big__a", "x".repeat(400))], 0);
    const labels = items.map((item) => item.label);
    expect(labels.indexOf("MCP·big")).toBeLessThan(labels.indexOf("MCP·small"));
  });

  it("无 MCP 时只有三条；空系统提示零成本", () => {
    const items = contextItems("", [tool("read", {})], 100);
    expect(items).toHaveLength(3);
    expect(items[0]?.tokens).toBe(0);
  });
});
