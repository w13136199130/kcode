import { useCallback, useEffect, useRef, useState } from "react";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR, type HostEvent, type HostFrame } from "@kcode/contracts";
import type { HostConnection } from "@web/hooks/useHostConnection.js";

/**
 * 桌面宿主连接（N3-4 M1）：preload 转交的 MessagePort 上跑 host-protocol
 * （与 Web 端 useHostConnection 的 WebSocket 版同帧协议、同 HostConnection 接口——
 * Chat 组件层因此零改动复用）。reload 时 main 重挂新端口，本 hook 随页面重建。
 */

declare global {
  interface Window {
    kcodeHost?: {
      onPort(callback: (port: MessagePort) => void): void;
      onHostExit(callback: (code: number) => void): void;
    };
  }
}

export function useDesktopConnection(): HostConnection {
  const [status, setStatus] = useState<"connecting" | "ready" | "closed" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<HostEvent[]>([]);
  const portRef = useRef<MessagePort | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const pendingRef = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const idCounter = useRef(0);

  useEffect(() => {
    const bridge = window.kcodeHost;
    if (bridge === undefined) {
      setStatus("error");
      setError("preload 桥不可用（window.kcodeHost 未暴露）");
      return;
    }

    const failAll = (message: string): void => {
      for (const [, p] of pendingRef.current) p.reject(new Error(message));
      pendingRef.current.clear();
    };

    bridge.onPort((port) => {
      portRef.current = port;
      port.onmessage = (ev: MessageEvent) => {
        let frame: HostFrame;
        try {
          frame = JSON.parse(String(ev.data)) as HostFrame;
        } catch {
          return;
        }
        if (frame.kind === "hello") {
          setStatus("ready");
          return;
        }
        if (frame.kind === "res") {
          const pending = pendingRef.current.get(frame.id);
          if (pending !== undefined) {
            pendingRef.current.delete(frame.id);
            if (frame.ok) pending.resolve(frame.result);
            else pending.reject(new Error(frame.error));
          }
          return;
        }
        if (frame.kind === "ev") {
          setEvents((prev) => {
            const next = [...prev, frame.event];
            return next.length > 500 ? next.slice(-500) : next;
          });
        }
      };
      port.onclose = () => {
        setStatus("closed");
        failAll("宿主端口已关闭");
      };
      port.start();
      // 握手由本端发起（host 收到端口即等待 hello）
      port.postMessage(
        JSON.stringify({ kind: "hello", hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: [] } }),
      );
    });

    bridge.onHostExit(() => {
      setStatus("closed");
      failAll("宿主进程已退出");
    });

    return () => {
      portRef.current?.close();
      failAll("连接已关闭");
    };
  }, []);

  const send = useCallback(async (method: string, params?: unknown): Promise<unknown> => {
    const port = portRef.current;
    if (port === null || statusRef.current !== "ready") {
      throw new Error(`宿主未就绪（${statusRef.current}），无法发送 ${method}`);
    }
    const id = `desktop-${++idCounter.current}`;
    return new Promise((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      port.postMessage(JSON.stringify({ kind: "req", id, method, ...(params !== undefined ? { params } : {}) }));
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id);
          reject(new Error(`请求超时：${method}`));
        }
      }, 30_000);
    });
  }, []);

  return { status, error, events, send, connect: () => window.location.reload() };
}
