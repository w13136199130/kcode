/**
 * transport（WSS/E2E epoch/配对/版本协商/TUF 更新链）+ auth（IdP Device Flow 客户端/keychain DPAPI·Keychain）
 * + providers（模型路由/凭证/受众校验）+ usage（签名上报/假名化）+ telemetry，§4.4。
 * P3/P4 落地；本地 API server（UDS/named pipe）在 apps/daemon 组装（§5.6.2）。
 */
export const PLATFORM_PHASE = "P3-P4";
