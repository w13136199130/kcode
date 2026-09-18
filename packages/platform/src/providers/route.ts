import type { LLMProvider, UserModelsConfig } from "@kcode/contracts";
import type { KeychainStore } from "../auth/keychain.js";
import { resolveApiKey } from "./credentials.js";
import { OpenAICompatibleProvider, type FetchLike, type OpenAICompatibleOptions } from "./openai-compatible.js";

export interface ProviderRouterOptions {
  fetch?: FetchLike;
}

export interface ProviderRouter {
  resolve(modelRef: string): Promise<LLMProvider>;
}

/** 官方 OpenAI 端点固定值（type=openai 时忽略自定义 baseURL，防漂移） */
const OPENAI_OFFICIAL_BASE = "https://api.openai.com/v1";

/** providers 路由（§5.7）：模型引用解析 → 用户级 provider 配置 → keychain 受众校验 → LLMProvider */
export function createProviderRouter(
  config: UserModelsConfig,
  keychain: KeychainStore,
  options: ProviderRouterOptions = {},
): ProviderRouter {
  return {
    async resolve(modelRef) {
      const { providerName, modelId } = parseModelRef(modelRef, config);
      const providerConfig = config.providers[providerName];
      if (providerConfig === undefined) {
        throw new Error(
          `未配置 provider "${providerName}"——providers 只存在于用户级 ~/.kcode/config.json（§5.7）`,
        );
      }
      if (providerConfig.type === "gateway") {
        throw new Error("网关模式 P5 落地（§5.7）；当前请使用 BYOK：openai / openai-compatible");
      }

      const baseURL = providerConfig.type === "openai" ? OPENAI_OFFICIAL_BASE : providerConfig.baseURL;
      const keyRef = providerConfig.keyRef;

      let entry = null;
      if (keyRef !== undefined) {
        entry = await keychain.get(keyRef);
        if (entry === null) {
          throw new Error(`keychain 中找不到 ${keyRef}；先用 kcode config 录入（§5.7）`);
        }
      }
      const apiKey = await resolveApiKey(entry, baseURL);

      const opts: OpenAICompatibleOptions = { baseURL, model: modelId, apiKey, fetch: options.fetch };
      return new OpenAICompatibleProvider(`openai-compatible:${providerName}`, opts);
    },
  };
}

/** 模型引用解析："deepseek/chat" → { deepseek, chat }；裸模型名沿用 default 的 provider（§5.7） */
export function parseModelRef(
  modelRef: string,
  config: UserModelsConfig,
): { providerName: string; modelId: string } {
  if (modelRef.includes("/")) {
    const [providerName, ...rest] = modelRef.split("/");
    return { providerName: providerName!, modelId: rest.join("/") };
  }
  const fallback = config.default ?? Object.keys(config.providers)[0];
  if (fallback === undefined || fallback === "") {
    throw new Error(`无法解析模型引用 "${modelRef}"：既无 provider 前缀，也无默认模型`);
  }
  const providerName = fallback.includes("/") ? fallback.split("/")[0]! : fallback;
  return { providerName, modelId: modelRef };
}
