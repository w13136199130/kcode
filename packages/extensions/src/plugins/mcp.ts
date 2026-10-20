import { McpServerConfig, type PluginManifest } from "@kcode/contracts";

/**
 * 3-16：插件 manifest.mcp → 会话 MCP 配置（按 transport 分流）。
 * - stdio：必须有 command；args/env 原样透传（缺省 []）
 * - http/sse：必须有 url
 * 不合法声明逐条告警跳过（坏一条不拖垮插件其余能力）。
 */
export function pluginMcpConfigs(manifest: PluginManifest): { configs: McpServerConfig[]; errors: string[] } {
  const configs: McpServerConfig[] = [];
  const errors: string[] = [];
  for (const decl of manifest.mcp) {
    const parsed = McpServerConfig.safeParse({
      name: decl.name,
      transport: decl.transport,
      ...(decl.command !== undefined ? { command: decl.command } : {}),
      ...(decl.args !== undefined ? { args: decl.args } : {}),
      ...(decl.env !== undefined ? { env: decl.env } : {}),
      ...(decl.url !== undefined ? { url: decl.url } : {}),
    });
    if (!parsed.success) {
      errors.push(`${decl.name}：${parsed.error.issues[0]?.message ?? "声明不合法"}`);
      continue;
    }
    configs.push(parsed.data);
  }
  return { configs, errors };
}
