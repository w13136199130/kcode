import { join } from "node:path";
import type { IPlatformService } from "@kcode/contracts";
import { createPlatformService } from "@kcode/platform";

/**
 * 宿主侧平台服务（N3-2 注 E）：完整 IPlatformService——key 明文只在本进程停留。
 * 前端只拿到 PlatformClientPort（probe + saveKey），open*Keychain 不跨进程暴露。
 */
export function createCliPlatformService(kcodeHomeDir: string): IPlatformService {
  return createPlatformService({
    keysFile: join(kcodeHomeDir, "keys.json"),
    dpapiKeysFile: join(kcodeHomeDir, "keys.dpapi.json"),
  });
}
