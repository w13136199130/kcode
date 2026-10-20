/** 登录/onboarding 的厂商预设（CLI 与桌面共用；OpenAI 兼容端点） */
export interface LoginPreset {
  key: string;
  name: string;
  label: string;
  baseURL: string;
  model: string;
}

export const LOGIN_PRESETS: readonly LoginPreset[] = [
  {
    key: "1",
    name: "glm",
    label: "智谱 BigModel（glm-5.3）",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
  },
  {
    key: "2",
    name: "deepseek",
    label: "DeepSeek（deepseek-chat）",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    key: "3",
    name: "kimi",
    label: "Moonshot Kimi（kimi-k2）",
    baseURL: "https://api.moonshot.cn/v1",
    model: "kimi-k2",
  },
  { key: "4", name: "custom", label: "自定义 OpenAI 兼容端点（自行填写地址与模型名）", baseURL: "", model: "" },
];
