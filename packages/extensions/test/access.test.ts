import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionEngine, ToolDefinition } from "@kcode/contracts";
import { ReadOnlyAccessEngine, accessModeFromEnv } from "../src/permissions/access.js";

const readonlyTool: ToolDefinition = {
  name: "read",
  description: "read",
  parameters: { type: "object" },
  readOnly: true,
};
const writeTool: ToolDefinition = {
  name: "write",
  description: "write",
  parameters: { type: "object" },
  readOnly: false,
};

const allowEngine: PermissionEngine = { decide: async (): Promise<PermissionDecision> => "allow" };

describe("AccessMode（read-only）", () => {
  it("只放行 readOnly 工具，写工具/命令直接拒绝", async () => {
    const engine = new ReadOnlyAccessEngine(allowEngine);
    expect(await engine.decide(readonlyTool, {})).toBe("allow");
    expect(await engine.decide(writeTool, {})).toBe("deny");
  });

  it("环境变量默认 workspace-write，显式 read-only 才收紧", () => {
    expect(accessModeFromEnv({})).toBe("workspace-write");
    expect(accessModeFromEnv({ KCODE_ACCESS_MODE: "read-only" })).toBe("read-only");
  });
});
