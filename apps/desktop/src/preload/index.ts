import { contextBridge, ipcRenderer } from "electron";

/**
 * 桌面 preload（§8.4g 安全边界）：contextBridge 只暴露宿主端口桥与宿主退出通知——
 * 集中单文件便于权限审计（zcode 同款纪律）。端口即凭证：只经此通道转交给本窗口 renderer。
 *
 * 两个实测教训（M1 排障记录）：
 * - MessagePort 本体不过桥（contextBridge 结构化克隆不支持）——preload 持有端口，
 *   只暴露 send/onMessage 函数与字符串载荷；
 * - preload 侧拿到的是 DOM 版 MessagePort（onmessage 风格，无 .on/close 事件）——
 *   端口远端关闭在 DOM API 无回调，断连感知统一走 onHostExit。
 */
const messageHandlers = new Set<(data: string) => void>();
let port: MessagePort | null = null;

ipcRenderer.on("kcode:host-port", (event) => {
  const [p] = (event as unknown as { ports: MessagePort[] }).ports;
  if (p === undefined) return;
  port = p;
  p.onmessage = (ev: MessageEvent) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    for (const h of messageHandlers) h(data);
  };
});

contextBridge.exposeInMainWorld("kcodeHost", {
  /** 宿主帧到达（一消息一 JSON 字符串，host-protocol） */
  onMessage(callback: (data: string) => void): void {
    messageHandlers.add(callback);
  },
  /** 发送宿主帧（JSON 字符串） */
  send(data: string): void {
    port?.postMessage(data);
  },
  /** 宿主进程退出通知（崩溃/结束/断连兜底）——renderer 据此提示重连或开新会话 */
  onHostExit(callback: (code: number) => void): void {
    ipcRenderer.on("kcode:host-exit", (_event, code: number) => callback(code));
  },
});
