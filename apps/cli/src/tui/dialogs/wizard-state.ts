/** /login 向导的厂商预设（与桌面 onboarding 共用 contracts 单一事实源） */
export { LOGIN_PRESETS } from "@kcode/contracts";

export type LoginWizard =
  | null
  | {
      stage: "method" | "model" | "baseURL" | "apikey" | "passphrase";
      providerName: string;
      presetBaseURL: string;
      presetModel: string;
      baseURL: string;
      apiKey: string;
      model: string;
    };


