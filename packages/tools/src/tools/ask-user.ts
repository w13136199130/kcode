import { StructuredQuestion, type Tool, type UserPromptPort } from "@kcode/contracts";

/** ask_user 工具（§1.1 A 域结构化提问）：向用户提出选择题；非交互环境返回降级话术 */
export function createAskUserTool(opts: { prompt?: UserPromptPort }): Tool {
  return {
    definition: {
      name: "ask_user",
      description:
        "向用户提出结构化选择题：{ question, options: [{label, description}]（至少 2 项）, multiSelect }；非交互环境不可用",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean" },
        },
        required: ["question", "options"],
      },
      readOnly: true,
    },
    async execute(input) {
      const parsed = StructuredQuestion.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      if (opts.prompt === undefined) {
        return {
          ok: true,
          output: "用户当前不可交互（非交互模式）——请基于已知信息继续，不要臆测用户的选择。",
        };
      }
      const answers = await opts.prompt.ask(parsed.data);
      if (answers.length === 0) {
        return { ok: true, output: "用户未作选择（已跳过）。" };
      }
      return { ok: true, output: `用户选择：${answers.join("、")}` };
    },
  };
}
