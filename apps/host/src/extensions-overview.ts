import { join } from "node:path";
import { isProjectTrusted, loadMcpConfigs } from "@kcode/session";
import type { McpServerConfig } from "@kcode/contracts";
import {
  buildExtensionRoots,
  discoverCommands,
  FsSkillLibrary,
  installPlugin,
  latestInstalledPlugins,
  listInstalledPlugins,
  loadTrustedKeys,
  readDisabledPlugins,
  setPluginEnabled,
  verifyInstalledPlugin,
} from "@kcode/extensions";

/**
 * S1-6（F14）：设置页「扩展」一站式清单（插件/技能/命令/MCP）。
 * 只读聚合——能力本体（启停/装卸/签名）复用 @kcode/extensions 既有实现；
 * 项目级来源（.kcode/skills、.kcode/commands、项目 mcp.json）遵守 trust 边界。
 */
export interface ExtensionsOverview {
  plugins: Array<{
    name: string;
    version: string;
    enabled: boolean;
    signed: boolean;
    signedBy?: string;
    skills: number;
    commands: number;
    hooks: number;
    mcp: number;
    installPath: string;
  }>;
  skills: Array<{ name: string; description: string; source: string; manualOnly: boolean }>;
  commands: Array<{ name: string; source: string; description?: string }>;
  mcp: {
    user: Array<{ name: string; transport: string }>;
    project: Array<{ name: string; transport: string }>;
  };
}

const shapeServers = (servers: McpServerConfig[]): Array<{ name: string; transport: string }> =>
  servers.map((server) => ({ name: server.name, transport: server.transport }));

export async function extensionsOverview(kcodeHomeDir: string, cwd: string): Promise<ExtensionsOverview> {
  const pluginsDir = join(kcodeHomeDir, "cli", "plugins");
  const installed = latestInstalledPlugins(await listInstalledPlugins(join(pluginsDir, "cache")));
  const disabled = new Set(await readDisabledPlugins(pluginsDir));
  const trustedKeys = await loadTrustedKeys(kcodeHomeDir);

  const plugins: ExtensionsOverview["plugins"] = [];
  for (const plugin of installed) {
    const isDisabled =
      disabled.has(plugin.manifest.name) || disabled.has(`${plugin.manifest.name}@${plugin.manifest.version}`);
    const verify = await verifyInstalledPlugin(plugin, { trustedKeys });
    plugins.push({
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      enabled: !isDisabled,
      // 未签名插件本地可装载（verify.ok）；「已签名」以命中受信发布者为准
      signed: verify.signedBy !== undefined,
      ...(verify.signedBy !== undefined ? { signedBy: verify.signedBy } : {}),
      skills: plugin.manifest.skills.length,
      commands: plugin.manifest.commands.length,
      hooks: plugin.manifest.hooks.length,
      mcp: plugin.manifest.mcp.length,
      installPath: plugin.installPath,
    });
  }

  const trusted = cwd !== "" ? await isProjectTrusted(cwd, kcodeHomeDir) : false;
  const roots = await buildExtensionRoots({ cwd: cwd !== "" ? cwd : kcodeHomeDir, kcodeHomeDir, trusted });
  const skillLib = await FsSkillLibrary.open(roots.skillRoots);
  const skills = skillLib.list().map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    manualOnly: skill.manualOnly,
  }));
  const commands = (await discoverCommands(roots.commandRoots)).map((cmd) => ({
    name: cmd.name,
    source: cmd.source,
    ...(cmd.description !== undefined ? { description: cmd.description } : {}),
  }));
  // loadMcpConfigs 返回项目>用户的同名合并扁平表；分两级展示：先取纯用户级，再从合并表差出项目级
  const userServers = await loadMcpConfigs(kcodeHomeDir);
  const merged = cwd !== "" ? await loadMcpConfigs(kcodeHomeDir, { projectDir: cwd, trusted }) : userServers;
  const userNames = new Set(userServers.map((server) => server.name));

  return {
    plugins,
    skills,
    commands,
    mcp: {
      user: shapeServers(userServers),
      project: shapeServers(merged.filter((server) => !userNames.has(server.name))),
    },
  };
}

/** S1-6：插件启停（写 state.json；与 CLI kcode plugin enable/disable 同一存储）。 */
export async function setPluginListEnabled(kcodeHomeDir: string, name: string, enabled: boolean): Promise<void> {
  await setPluginEnabled(join(kcodeHomeDir, "cli", "plugins"), name, enabled);
}

/** S1-6：从本地目录安装插件（本地插件管理优先；返回名称/版本/同意摘要）。 */
export async function installPluginFromDir(
  kcodeHomeDir: string,
  sourceDir: string,
): Promise<{ name: string; version: string; installPath: string; consentSummary: string }> {
  const result = await installPlugin(sourceDir, join(kcodeHomeDir, "cli", "plugins", "cache"), {
    trustedKeys: await loadTrustedKeys(kcodeHomeDir),
  });
  return {
    name: result.name,
    version: result.version,
    installPath: result.installPath,
    consentSummary: result.consentSummary,
  };
}
