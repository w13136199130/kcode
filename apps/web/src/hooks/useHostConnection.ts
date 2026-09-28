import { useCallback, useEffect, useRef, useState } from "react";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR, type HostFrame, type HostEvent } from "@kcode/contracts";

/**
 * WebSocket 宿主连接 Hook（N3-3）：
 * 连接中继服务器（ws://host:port/ws?token=xxx），透传宿主协议帧。
 * 返回：连接状态、事件流、发送命令的方法——组件只消费这三样。
 */

export interface HostConnection {
  status: "connecting" | "ready" | "closed" | "error";
  error: string | null;
  events: HostEvent[];
  send: (method: string, params?: unknown) => Promise<unknown>;
  connect: () => void;
}

export function useHostConnection(wsUrl: string): HostConnection {
  const [status, setStatus] = useState<"connecting" | "ready" | "closed" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<HostEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const idCounter = useRef(0);

  const connect = useCallback(() => {
    setStatus("connecting");
    setError(null);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // 握手
      ws.send(JSON.stringify({ kind: "hello", hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: [] } }));
    };

    ws.onmessage = (msg) => {
      let frame: HostFrame;
      try {
        frame = JSON.parse(msg.data as string) as HostFrame;
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
          if (frame.ok) {
            pending.resolve(frame.result);
          } else {
            pending.reject(new Error(frame.error));
          }
        }
        return;
      }
      if (frame.kind === "ev") {
        setEvents((prev) => {
          const next = [...prev, frame.event];
          // 上限 500 条（防内存膨胀；宿主端 JSONL 是完整记录）
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setError("WebSocket 连接失败");
    };

    ws.onclose = () => {
      setStatus("closed");
      // 释放所有 pending
      for (const [, p] of pendingRef.current) {
        p.reject(new Error("连接已关闭"));
      }
      pendingRef.current.clear();
    };

    wsRef.current = ws;
  }, [wsUrl]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback(async (method: string, params?: unknown): Promise<unknown> => {
    const ws = wsRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }
    const id = `web-${++idCounter.current}`;
    return new Promise((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      ws.send(JSON.stringify({ kind: "req", id, method, ...(params !== undefined ? { params } : {}) }));
      // 30s 超时
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id);
          reject(new Error(`请求超时：${method}`));
        }
      }, 30_000);
    });
  }, []);

  return { status, error, events, send, connect };
}
