import type { ReactNode } from "react";
import type { MenuOption } from "./OptionsMenu.js";
import type { LoginWizard } from "./wizard-state.js";
import type { AskState, QuestionState, PlanApprovalState } from "../state/interactions.js";
import { LoginWizardPanel } from "./LoginWizardPanel.js";
import {
  AskPanel,
  FullAccessConfirmPanel,
  ModelPickerPanel,
  PermissionsPanel,
  PlanApprovalPanel,
  QuestionPanel,
  ResumePickerPanel,
  RewindPickerPanel,
  type RewindPoint,
} from "./panels.js";

/**
 * 交互面板层（N2-3 外迁；注入补全后只收状态 props）：
 * 同一时刻至多一个面板——审批/计划/回退/续接/放行/全访问确认/login 向导/模型选择/结构化提问，
 * 均空闲时回落到 children（输入区）。动作与平台能力经 useServices 取（state/services.ts）。
 */
export function DialogLayer(props: {
  ask: AskState | null;
  question: QuestionState | null;
  planApproval: PlanApprovalState | null;
  rewindPicker: RewindPoint[] | null;
  resumePicker: { options: MenuOption[]; ids: string[] } | null;
  permissionsPanel: string[] | null;
  fullAccessConfirm: boolean;
  loginWizard: LoginWizard;
  modelPicker: { options: MenuOption[] } | null;
  children: ReactNode;
}) {
  if (props.ask !== null) {
    return <AskPanel ask={props.ask} />;
  }
  if (props.planApproval !== null) {
    return <PlanApprovalPanel planApproval={props.planApproval} />;
  }
  if (props.rewindPicker !== null) {
    return <RewindPickerPanel points={props.rewindPicker} />;
  }
  if (props.resumePicker !== null) {
    return <ResumePickerPanel options={props.resumePicker.options} ids={props.resumePicker.ids} />;
  }
  if (props.permissionsPanel !== null) {
    return <PermissionsPanel grants={props.permissionsPanel} />;
  }
  if (props.fullAccessConfirm) {
    return <FullAccessConfirmPanel />;
  }
  if (props.loginWizard !== null) {
    return <LoginWizardPanel wizard={props.loginWizard} />;
  }
  if (props.modelPicker !== null) {
    return <ModelPickerPanel options={props.modelPicker.options} />;
  }
  if (props.question !== null) {
    return <QuestionPanel question={props.question} />;
  }
  return <>{props.children}</>;
}
