export {
  readPluginManifest,
  buildConsentSummary,
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  verifyPluginSeed,
  compareVersions,
  latestInstalledPlugins,
  type PluginInstallResult,
  type InstalledPlugin,
} from "./install.js";
export {
  readDisabledPlugins,
  setPluginEnabled,
  filterEnabledPlugins,
} from "./state.js";
export { parsePluginPermissions, PluginPermissionEngine, type ParsedPluginPermissions } from "./permissions.js";
export { pluginMcpConfigs } from "./mcp.js";
