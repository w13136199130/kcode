import { z } from "zod";

/** §4.3 插件清单 .kcode-plugin（路径正则防穿越 + 命名空间） */

export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-_.]{1,63}$/;

export const PluginName = z.string().regex(
  PLUGIN_NAME_RE,
  "插件/市场名非法：禁 ..、/、\\ 与前导点（防路径穿越）",
);
export type PluginName = z.infer<typeof PluginName>;

export const McpServerDecl = z.object({
  name: PluginName,
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  url: z.string().url().optional(),
});

export const HookDecl = z.object({
  event: z.enum(["session_start", "pre_tool_use", "post_tool_use", "stop"]),
  command: z.string().min(1),
});

export const PluginManifest = z
  .object({
    schema: z.literal("kcode.plugin/1"),
    name: PluginName,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    hooks: z.array(HookDecl).default([]),
    skills: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    mcp: z.array(McpServerDecl).default([]),
    permissions: z.array(z.string()).default([]),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifest>;

/** 安装 seed（版本+hash 锁定，升级必须显式；v1.1 加签名，ZCode 仅 hash） */
export const PluginSeed = z.object({
  hash: z.string().min(1),
  marketplace: PluginName,
  plugin: PluginName,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sig: z.string().min(1),
});
export type PluginSeed = z.infer<typeof PluginSeed>;

/** 插件注册物命名空间：plugin:<name>::<item>——deny 规则可精确匹配（§5.8） */
export function pluginNamespace(plugin: string, item: string): string {
  return `plugin:${plugin}::${item}`;
}
