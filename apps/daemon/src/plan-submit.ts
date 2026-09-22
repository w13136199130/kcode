import { z } from "zod";
import type { PermissionMode, Tool } from "@kcode/contracts";

const PlanSubmitArgs = z.object({
  plan: z.string().min(1),
});

/** 计划批准应答：approved 批准执行 / revise 继续研究完善 / abandon 放弃 */
export type PlanVerdict = "approved" | "revise" | "abandon";

export interface PlanSubmitToolDeps {
  currentMode: () => PermissionMode;
  /** 计划批准交互端口（daemon 注入；无交互通道时工具降级为未批准） */
  planAsker?: { ask(plan: string): Promise<PlanVerdict> };
  /** 批准后回调（composition：钉固计划锚点 + 切回执行模式） */
  onApproved: (plan: string) => void;
}

/**
 * plan_submit 工具（B2 计划双闸门）：模型在计划模式下产出计划后提交，
 * 等待用户批准——批准 = 切回 default 档继续执行；拒绝 = 留在 plan 档继续研究。
 * 计划文本本身已随本轮 assistant_message 进入上下文（批准后的执行锚点）。
 */
export function buildPlanSubmitTool(deps: PlanSubmitToolDeps): Tool {
  return {
    definition: {
      name: "plan_submit",
      description:
        "提交执行计划等待用户批准（仅计划模式）：产出完整计划 Markdown 后调用一次；批准后自动切回执行模式，请严格按计划执行",
      parameters: {
        type: "object",
        properties: {
          plan: { type: "string", description: "完整计划（Markdown：目标、步骤、涉及文件、风险）" },
        },
        required: ["plan"],
      },
      readOnly: true,
    },
    async execute(input) {
      const parsed = PlanSubmitArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      if (deps.currentMode() !== "plan") {
        return { ok: false, output: "", error: "当前不在计划模式（/plan 切入后研究并产出计划再提交）" };
      }
      if (deps.planAsker === undefined) {
        return {
          ok: false,
          output: "",
          error: "无交互通道，计划未获批准（headless 场景请退出计划模式后直接执行）",
        };
      }
      let verdict: PlanVerdict;
      try {
        verdict = await deps.planAsker.ask(parsed.data.plan);
      } catch {
        verdict = "abandon";
      }
      if (verdict === "approved") {
        deps.onApproved(parsed.data.plan);
        return {
          ok: true,
          output:
            "计划已获批准——已切换到执行模式。严格按计划逐步执行：先用 todo 拆解步骤，涉及写入的操作会正常走权限确认。",
        };
      }
      if (verdict === "revise") {
        return {
          ok: false,
          output: "",
          error: "用户要求继续研究完善计划（补充调研后重新提交，勿重复提交相同内容）",
        };
      }
      return { ok: false, output: "", error: "用户放弃该计划——停止当前任务并等待新指示" };
    },
  };
}
