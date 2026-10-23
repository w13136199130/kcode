export {
  readPluginManifest,
  buildConsentSummary,
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  verifyPluginSeed,
  verifyInstalledPlugin,
  hashPluginContent,
  compareVersions,
  latestInstalledPlugins,
  type PluginInstallResult,
  type InstalledPlugin,
} from "./install.js";
export {
  PLUGIN_SIGNATURE_FILE,
  addTrustedKey,
  generateSigningKeyPair,
  keyIdFor,
  loadTrustedKeys,
  publicKeyFromPrivate,
  readPluginSignature,
  signPlugin,
  trustStorePath,
  verifyPluginSignature,
  writePluginSignature,
  type PluginSignature,
  type TrustedPublisherKey,
} from "./signing.js";
export {
  readDisabledPlugins,
  setPluginEnabled,
  filterEnabledPlugins,
} from "./state.js";
export { parsePluginPermissions, PluginPermissionEngine, type ParsedPluginPermissions } from "./permissions.js";
export { pluginMcpConfigs } from "./mcp.js";
