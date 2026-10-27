import { useCallback } from "react";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/** 模型选择：列表来自 host models/list；切换走 session/set_model，成功后才改 UI 状态。 */
export function useModelPicker(options: {
  conn: HostConnection;
  model: string | null;
  setModel(value: string): void;
  notify(text: string): void;
}) {
  const listModels = useCallback(async (): Promise<string[]> => {
    if (options.model === null) return [];
    try {
      const result = (await options.conn.send("models/list", { model: options.model })) as { models?: unknown };
      const models = Array.isArray(result.models)
        ? result.models.filter((item): item is string => typeof item === "string" && item !== "")
        : [];
      return models.length > 0 ? models : [options.model];
    } catch {
      // 某些 provider 不支持 /models：至少保留当前模型可选。
      return [options.model];
    }
  }, [options.conn, options.model]);

  const changeModel = useCallback(
    async (ref: string): Promise<boolean> => {
      if (ref === "" || ref === options.model) return true;
      try {
        const result = (await options.conn.send("session/set_model", { ref })) as { error?: string } | undefined;
        if (result?.error !== undefined) {
          options.notify(`模型切换失败：${result.error}`);
          return false;
        }
        options.setModel(ref);
        return true;
      } catch (err) {
        options.notify(`模型切换失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
    [options.conn, options.model, options.notify, options.setModel],
  );

  return { listModels, changeModel };
}
