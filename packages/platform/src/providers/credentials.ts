import type { KeychainEntry } from "@kcode/contracts";

/**
 * §5.7 受众绑定（第二层防御，同类产品少有）：
 * key 只允许发往 keychain 条目登记的 audiences 端点；不匹配即硬失败——
 * 项目配置被篡改或程序 bug 均无法把 key 发往新端点，改端点必须重新授权。
 */
export async function resolveApiKey(
  entry: KeychainEntry | null,
  baseURL: string,
): Promise<string | undefined> {
  if (entry === null) {
    return undefined; // 未绑定 key：本地 Ollama 等无鉴权端点
  }
  if (!entry.audiences.includes(baseURL)) {
    throw new Error(
      `key ${entry.ref} 的受众不包含 ${baseURL}——受众绑定校验失败（§5.7）。` +
        "key 只能发往 keychain 登记的端点；更换端点需重新授权。",
    );
  }
  return entry.key;
}
