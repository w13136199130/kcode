/**
 * provider 能力声明/探测（§5.7）：P1 用静态表；
 * P1 末补启动探测 + 不支持 tool calling 的模型给出明确降级提示（内置工具强依赖）。
 */
export interface ProviderCapabilities {
  toolCalling: boolean;
  multimodal: boolean;
  promptCache: boolean;
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  toolCalling: true,
  multimodal: false,
  promptCache: false,
};

/** 已知端点能力表（未列出者用 DEFAULT，探测接入后覆盖） */
export const KNOWN_PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  openai: { toolCalling: true, multimodal: true, promptCache: true },
  deepseek: { toolCalling: true, multimodal: false, promptCache: true },
  kcode: { toolCalling: true, multimodal: true, promptCache: true },
};
