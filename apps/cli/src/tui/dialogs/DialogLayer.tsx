import type { ReactNode } from "react";
import type { PermissionMode } from "@kcode/contracts";
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
  type PushBlock,
  type RewindPoint,
} from "./panels.js";

/**
 * 交互面板层（N2-3 外迁）：同一时刻至多一个面板——审批/计划/回退/续接/放行/全访问确认/
 * login 向导/模型选择/结构化提问，均空闲时回落到 children（输入区）。
 * 面板只收动作与状态 props（platform 经 useServices 注入），不碰 App 内部。
 */
export function DialogLayer(props: {
  ask: AskState | null;
  setAsk: (a: AskState | null) => void;
  question: QuestionState | null;
  setQuestion: (q: QuestionState | null) => void;
  planApproval: PlanApprovalState | null;
  setPlanApproval: (p: PlanApprovalState | null) => void;
  setMode: (m: PermissionMode) => void;
  setEngineMode: (m: PermissionMode) => void;
  rewindPicker: RewindPoint[] | null;
  setRewindPicker: (p: RewindPoint[] | null) => void;
  rewind: (eventIndex: number) => Promise<string | null>;
  resumePicker: { options: MenuOption[]; ids: string[] } | null;
  setResumePicker: (p: { options: MenuOption[]; ids: string[] } | null) => void;
  switchSession: (resumeFrom: string) => void;
  permissionsPanel: string[] | null;
  setPermissionsPanel: (p: string[] | null) => void;
  clearPersistentGrants: () => Promise<boolean>;
  fullAccessConfirm: boolean;
  setFullAccessConfirm: (v: boolean) => void;
  applyMode: (m: PermissionMode) => void;
  loginWizard: LoginWizard;
  setLoginWizard: (w: LoginWizard) => void;
  modelPicker: { options: MenuOption[] } | null;
  setModelPicker: (p: { options: MenuOption[] } | null) => void;
  setModelLabel: (label: string) => void;
  setModel: (ref: string) => Promise<string | null>;
  pushBlock: PushBlock;
  children: ReactNode;
}) {
  if (props.ask !== null) {
    return <AskPanel ask={props.ask} setAsk={props.setAsk} pushBlock={props.pushBlock} />;
  }
  if (props.planApproval !== null) {
    return (
      <PlanApprovalPanel
        planApproval={props.planApproval}
        setPlanApproval={props.setPlanApproval}
        setMode={props.setMode}
        setEngineMode={props.setEngineMode}
        pushBlock={props.pushBlock}
      />
    );
  }
  if (props.rewindPicker !== null) {
    return (
      <RewindPickerPanel
        points={props.rewindPicker}
        setRewindPicker={props.setRewindPicker}
        rewind={props.rewind}
        pushBlock={props.pushBlock}
      />
    );
  }
  if (props.resumePicker !== null) {
    return (
      <ResumePickerPanel
        options={props.resumePicker.options}
        ids={props.resumePicker.ids}
        setResumePicker={props.setResumePicker}
        switchSession={props.switchSession}
      />
    );
  }
  if (props.permissionsPanel !== null) {
    return (
      <PermissionsPanel
        grants={props.permissionsPanel}
        setPermissionsPanel={props.setPermissionsPanel}
        clearPersistentGrants={props.clearPersistentGrants}
        pushBlock={props.pushBlock}
      />
    );
  }
  if (props.fullAccessConfirm) {
    return (
      <FullAccessConfirmPanel
        setFullAccessConfirm={props.setFullAccessConfirm}
        applyMode={props.applyMode}
        pushBlock={props.pushBlock}
      />
    );
  }
  if (props.loginWizard !== null) {
    return (
      <LoginWizardPanel
        wizard={props.loginWizard}
        setLoginWizard={props.setLoginWizard}
        pushBlock={props.pushBlock}
      />
    );
  }
  if (props.modelPicker !== null) {
    return (
      <ModelPickerPanel
        options={props.modelPicker.options}
        setModelPicker={props.setModelPicker}
        setModelLabel={props.setModelLabel}
        setModel={props.setModel}
        pushBlock={props.pushBlock}
      />
    );
  }
  if (props.question !== null) {
    return <QuestionPanel question={props.question} setQuestion={props.setQuestion} pushBlock={props.pushBlock} />;
  }
  return <>{props.children}</>;
}
