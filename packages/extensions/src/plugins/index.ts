export {
  readPluginManifest,
  buildConsentSummary,
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  type PluginInstallResult,
  type InstalledPlugin,
} from "./install.js";
export {
  readDisabledPlugins,
  setPluginEnabled,
  filterEnabledPlugins,
} from "./state.js";
