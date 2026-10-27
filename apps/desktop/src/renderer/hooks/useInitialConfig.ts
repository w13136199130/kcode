import { useEffect, type Dispatch, type SetStateAction } from "react";

/**
 * 首帧配置读取（D1-01 + 默认 cwd）——S0-4 从 main.tsx 原样拆出。
 * 配置读取完成（即使为空）才放行进入 onboarding/工作区；上次 cwd 优先，目录失效时由 host 报错后重选。
 */
export function useInitialConfig(opts: {
  setModelDefault: Dispatch<SetStateAction<string | null>>;
  setConfigLoaded: Dispatch<SetStateAction<boolean>>;
  setDefaultCwd: Dispatch<SetStateAction<string>>;
}): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const model = await window.kcodeHost?.getDefaultModel();
        if (!cancelled) opts.setModelDefault(model ?? null);
      } catch {
        if (!cancelled) opts.setModelDefault(null);
      } finally {
        if (!cancelled) opts.setConfigLoaded(true);
      }
    })();
    void window.kcodeHost?.getDefaultCwd().then((fallback) => {
      // 上次选过的项目优先；目录被删除时 host 会报错，用户可用「打开文件夹」重选
      const last = localStorage.getItem("kcode-last-cwd");
      if (!cancelled) opts.setDefaultCwd(last !== null && last !== "" ? last : fallback);
    });
    return () => {
      cancelled = true;
    };
  }, []);
}
