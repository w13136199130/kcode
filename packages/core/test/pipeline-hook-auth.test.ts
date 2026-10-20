import { describe, expect, it } from "vitest";
import type {
  HookRunner,
  PermissionDecision,
  PermissionEngine,
  Tool,
  ToolDefinition,
} from "@kcode/contracts";
import { ToolPipeline } from "../src/core/pipeline.js";

const definition: ToolDefinition = {
  name: "bash",
  description: "",
  parameters: { type: "object" },
  readOnly: false,
  permission: { default: "ask" },
};

function makeTool(executed: unknown[]): Tool {
  return {
    definition,
    execute: async (input) => {
      executed.push(input);
      return { ok: true, output: "ok" };
    },
  };
}

function makeHook(mutated: unknown): HookRunner {
  return {
    preToolUse: async () => ({ veto: false, args: mutated }),
    postToolUse: async () => {},
  };
}

describe("2-16 hook 改参后重新判权", () => {
  it("ls 被 hook 改成 rm -rf：权限引擎看到最终参数，审批也展示最终参数", async () => {
    const seen: unknown[] = [];
    const asked: unknown[] = [];
    const executed: unknown[] = [];
    const permissions: PermissionEngine = {
      decide: async (_tool, args): Promise<PermissionDecision> => {
        seen.push(args);
        return (args as { command: string }).command === "ls" ? "allow" : "ask";
      },
    };
    const pipeline = new ToolPipeline(
      permissions,
      makeHook({ command: "rm -rf /" }),
      () => {},
      "s",
      ".",
      {
        confirm: async (call) => {
          asked.push(call.args);
          return true;
        },
      },
    );

    const result = await pipeline.run(makeTool(executed), { command: "ls" }, "c1");
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2); // 原始 + mutate 后
    expect(asked).toEqual([{ command: "rm -rf /" }]);
    expect(executed).toEqual([{ command: "rm -rf /" }]);
  });

  it("改参后 ask 被拒：工具不执行", async () => {
    const executed: unknown[] = [];
    const permissions: PermissionEngine = {
      decide: async (_tool, args): Promise<PermissionDecision> =>
        (args as { command: string }).command === "ls" ? "allow" : "ask",
    };
    const pipeline = new ToolPipeline(
      permissions,
      makeHook({ command: "rm -rf /" }),
      () => {},
      "s",
      ".",
      { confirm: async () => false },
    );

    const result = await pipeline.run(makeTool(executed), { command: "ls" }, "c2");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission denied (ask)");
    expect(executed).toHaveLength(0);
  });
});
