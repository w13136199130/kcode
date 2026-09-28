import type { MutableRefObject } from "react";
import type {
  AskPreviewPayload,
  PermissionAnswer,
  PermissionAsker,
  StructuredQuestion,
  ToolCallRef,
  UserPromptPort,
} from "@kcode/contracts";
import type { UiStore } from "@kcode/ui";

/** 审批面板状态（工具确认：call + resolve） */
export interface AskState {
  call: ToolCallRef & { args: unknown; preview?: AskPreviewPayload };
  resolve: (answer: boolean | PermissionAnswer) => void;
}

/** 结构化提问面板状态 */
export interface QuestionState {
  question: StructuredQuestion;
  resolve: (labels: string[]) => void;
}

/** 计划批准面板载荷（plan_submit 工具推送） */
export interface PlanApprovalState {
  plan: string;
  question: { question: string; options: { label: string; description?: string }[] };
  reply: (labels: string[]) => void;
}

/**
 * 权限审批 / 结构化提问 / 计划批准三类交互入口（N2-3 外迁）：
 * 面板状态由 App 持有，此处只做守卫——中断中直接拒绝/空答，非交互环境自动拒绝。
 */
export function makeInteractions(deps: {
  ui: UiStore;
  interactive: boolean;
  abortSent: MutableRefObject<boolean>;
  setAsk: (ask: AskState | null) => void;
  setQuestion: (q: QuestionState | null) => void;
  setPlanApproval: (p: PlanApprovalState | null) => void;
}): { asker: PermissionAsker; askUser: UserPromptPort; onPlanApproval: (payload: PlanApprovalState) => void } {
  const { ui, interactive, abortSent, setAsk, setQuestion, setPlanApproval } = deps;
  /** 计划批准交互（plan_submit 触发）：批准后由面板回调切换执行档 */
  const onPlanApproval = (payload: PlanApprovalState): void => {
    if (abortSent.current) {
      payload.reply([]);
      return;
    }
    setPlanApproval(payload);
  };

  const asker: PermissionAsker = {
    confirm: (call) =>
      new Promise<boolean | PermissionAnswer>((resolve) => {
        if (abortSent.current) { resolve(false); return; }
        if (!interactive) {
          // 非交互环境（管道/CI）自动拒绝——automation 同款语义（§5.5）
          ui.getState().setNotice(`非交互环境，已自动拒绝 ${call.tool}`);
          resolve(false);
          return;
        }
        setAsk({ call: call as AskState["call"], resolve });
      }),
  };

  const askUser: UserPromptPort = {
    ask: (q) =>
      new Promise<string[]>((resolve) => {
        if (abortSent.current) { resolve([]); return; }
        if (!interactive) {
          resolve([]);
          return;
        }
        setQuestion({ question: q, resolve });
      }),
  };

  return { asker, askUser, onPlanApproval };
}
