import type { PermissionMode } from "@kcode/contracts";
import type { ServiceSet, UiStore, Block } from "@kcode/ui";
import type { SessionHandle } from "../../session.js";
import type { MenuOption } from "../dialogs/OptionsMenu.js";
import type { LoginWizard } from "../dialogs/wizard-state.js";
import type { AskState, DiffBrowserState, QuestionState, PlanApprovalState, RewindPoint } from "./interactions.js";

/**
 * 对话框动作包（N2-3 注入补全）：面板 setter 与引擎动作的稳定集合，
 * 经 ServicesProvider 一次注入——DialogLayer 不再逐面板透传回调（28 props → 状态 props）。
 */
interface DialogActions {
  /** 本地面板状态 + 引擎换档 */
  setMode(mode: PermissionMode): void;
  applyMode(mode: PermissionMode): void;
  /** /resume 换建会话 */
  switchSession(resumeFrom: string): void;
  /** 回退到某个提问之前（/rewind） */
  rewind(eventIndex: number): Promise<string | null>;
  /** 3-23：回退单个文件的检查点改动并刷新 /diff 清单（返回剩余文件数或错误） */
  revertFile(path: string): Promise<{ remaining: number } | string>;
  /** 运行期换模型（/model） */
  setModel(ref: string): Promise<string | null>;
  setModelLabel(label: string): void;
  /** /login 保存后重读配置并让当前会话切到新模型（2-01，无需重启） */
  reloadRuntime(model: string): Promise<string | null>;
  /** /permissions 清空本项目持久放行 */
  clearPersistentGrants(): Promise<boolean>;
  pushBlock(block: Block): void;
  /** 面板开关（值为 null/boolean 关闭） */
  setAsk(ask: AskState | null): void;
  setQuestion(question: QuestionState | null): void;
  setPlanApproval(plan: PlanApprovalState | null): void;
  setRewindPicker(points: RewindPoint[] | null): void;
  setDiffBrowser(panel: DiffBrowserState | null): void;
  setResumePicker(picker: { options: MenuOption[]; ids: string[] } | null): void;
  setPermissionsPanel(panel: string[] | null): void;
  setFullAccessConfirm(v: boolean): void;
  setLoginWizard(wizard: LoginWizard): void;
  setModelPicker(picker: { options: MenuOption[] } | null): void;
}

/** CLI 侧服务集（宿主 App 装配；面板组件只经 useServices 取用，N2-3 注入模式） */
export type CliServices = ServiceSet & {
  /** 前端侧平台端口（N3-2 注 E：只暴露 probe/saveKey，open*Keychain 不出宿主） */
  platform: import("@kcode/contracts").PlatformClientPort;
  /** UI 语义 store（转写/运行状态） */
  ui: UiStore;
  /** 当前用户级配置文件（--settings 覆盖；/login 写回这里） */
  configPath: string;
  /** 当前会话句柄（换建后指向新会话） */
  getSession(): SessionHandle | null;
  dialogs: DialogActions;
};
