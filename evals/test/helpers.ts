import type { Tool, ToolDefinition } from "@kcode/contracts";

const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "回显消息",
  parameters: { type: "object", properties: { msg: { type: "string" } } },
  readOnly: true,
};

/** 测试用 echo 工具（evals 共享） */
export function echoToolFor(): Tool {
  return {
    definition: echoDefinition,
    execute: async (input) => {
      const { msg } = input as { msg: string };
      return { ok: true, output: msg };
    },
  };
}
