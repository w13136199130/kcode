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

/** 回退点（/rewind 面板与 DialogActions 共用形状；放 interactions 破 dialogs↔state 类型环） */
export interface RewindPoint {
  eventIndex: number;
  preview: string;
  ts: number;
  fileChanges: number;
  /** 4-06.1：完整提问（编辑面板预填） */
  text?: string;
}

/** 4-06.1：消息选择面板（选中后打开编辑面板） */
export interface MessagePickerState {
  points: RewindPoint[];
}

/** 4-06.1：消息编辑面板（事件索引 + 预填文本） */
export interface MessageEditState {
  eventIndex: number;
  text: string;
}

/** 3-23：单个改动文件（检查点基线 → 当前磁盘），与 @kcode/session 的 FileChange 同形 */
export interface DiffChange {
  path: string;
  diff: string;
  callIds: string[];
  existed: boolean;
}

/** /diff 面板状态：改动清单 + 打开时的筛选词（回退后按同词刷新） */
export interface DiffBrowserState {
  changes: DiffChange[];
  query?: string;
  /** `/diff <文件>` 唯一命中时直接进入该文件的 hunk 视图 */
  focusPath?: string;
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
