import type { Tool, ToolDefinition } from "@kcode/contracts";

const echoDefinition: ToolDefinition = {
  name: "echo",
  description: "回显消息",
  parameters: { type: "object", properties: { msg: { type: "string" } } },
  readOnly: true,
};

/** 测试用 echo 工具（记录收到的消息） */
export function echoToolFor(received: string[]): Tool {
  return {
    definition: echoDefinition,
    execute: async (input) => {
      const { msg } = input as { msg: string };
      received.push(msg);
      return { ok: true, output: msg };
    },
  };
}

/** 测试用 echo 工具（无副作用版本） */
export function simpleEchoTool(): Tool {
  return {
    definition: echoDefinition,
    execute: async (input) => {
      const { msg } = input as { msg: string };
      return { ok: true, output: msg };
    },
  };
}
