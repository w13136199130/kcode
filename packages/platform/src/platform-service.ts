import type { IPlatformService } from "@kcode/contracts";
import { DpapiKeychain } from "./auth/dpapi-keychain.js";
import { EncryptedFileKeychain, openKeychain } from "./auth/keychain.js";

/**
 * IPlatformService 默认实现（N2-1 装配件）：宿主（CLI bootstrap / N3 Web 入口）构造后注入 UI。
 * 存储路径由宿主给定（CLI 为 ~/.kcode/keys.json 与 keys.dpapi.json），实现不猜家目录。
 */
export function createPlatformService(paths: {
  keysFile: string;
  dpapiKeysFile: string;
}): IPlatformService {
  return {
    secureStorageAvailable: DpapiKeychain.available,
    openDefaultKeychain: () => openKeychain(paths.keysFile),
    openPassphraseKeychain: (passphrase) => new EncryptedFileKeychain(paths.keysFile, passphrase),
    openSecureKeychain: () => {
      if (!DpapiKeychain.available) {
        throw new Error("当前平台不支持免口令系统存储（仅 Windows DPAPI）——口令不能为空");
      }
      return new DpapiKeychain(paths.dpapiKeysFile);
    },
    verifyEnvPassphrase: async () => {
      try {
        await EncryptedFileKeychain.fromEnv(paths.keysFile).list();
        return true;
      } catch {
        return false;
      }
    },
  };
}
