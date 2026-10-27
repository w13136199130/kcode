import { useEffect, type MutableRefObject } from "react";

import type { HostConnection } from "@web/hooks/useHostConnection.js";
import { describeCreateError, type CreateFailure } from "../lib/switch-guards.js";
import { rememberSessionWorkspace } from "../lib/session-workspaces.js";

/** 启动自动建会话：attach/hello 竞态重试，耗尽后落到失败卡片。 */
export function useBootSession(options: {
  conn: HostConnection;
  modelDefault: string | null;
  defaultCwd: string;
  createdRef: MutableRefObject<boolean>;
  /** S2-1 期间发现的慢机竞态：用户切换（dispose→create）后，boot 在途 create 的迟到
   * 回调会用旧会话 id 覆盖 sessionId——与 host 活动会话脱钩，事件按 id 路由全部入缓存。
   * epoch 不匹配即作废。 */
  switchEpoch: MutableRefObject<number>;
  setSessionId(value: string): void;
  setCreateFailure(value: CreateFailure): void;
}): void {
  useEffect(() => {
    if (
      options.conn.status !== "ready" ||
      options.createdRef.current ||
      options.modelDefault === null ||
      options.defaultCwd === ""
    ) {
      return;
    }
    options.createdRef.current = true;
    const epoch = options.switchEpoch.current;
    let attempts = 0;
    const bootRequestId = globalThis.crypto.randomUUID();
    const create = (): void => {
      void options.conn
        .send("session/create", { model: options.modelDefault, cwd: options.defaultCwd, requestId: bootRequestId })
        .then((result) => {
          if (epoch !== options.switchEpoch.current) return; // 迟到的 boot create：用户已切换，作废
          const id = (result as { sessionId: string }).sessionId;
          rememberSessionWorkspace(id, options.defaultCwd);
          options.setSessionId(id);
        })
        .catch((err) => {
          if (epoch !== options.switchEpoch.current) return;
          options.createdRef.current = false;
          if (attempts >= 3) {
            options.setCreateFailure({
              cwd: options.defaultCwd,
              requestId: bootRequestId,
              previousSessionId: null,
              error: describeCreateError(err),
            });
            return;
          }
          attempts += 1;
          window.setTimeout(create, 300 * attempts);
        });
    };
    create();
  }, [options.conn, options.conn.status, options.modelDefault, options.defaultCwd, options.createdRef]);
}
