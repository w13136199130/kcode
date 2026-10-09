import { contextBridge, ipcRenderer } from "electron";

/**
 * 桌面 preload（§8.4g 安全边界）：contextBridge 只暴露宿主端口桥与宿主退出通知——
 * 集中单文件便于权限审计（zcode 同款纪律）。端口即凭证：只经此通道转交给本窗口 renderer。
 */
contextBridge.exposeInMainWorld("kcodeHost", {
  /** 宿主端口到达（main 在每次加载完成时投递，reload 自动重挂） */
  onPort(callback: (port: MessagePort) => void): void {
    ipcRenderer.on("kcode:host-port", (event) => {
      const [port] = event.ports;
      if (port !== undefined) callback(port);
    });
  },
  /** 宿主进程退出通知（崩溃/结束）——renderer 据此提示重连或开新会话 */
  onHostExit(callback: (code: number) => void): void {
    ipcRenderer.on("kcode:host-exit", (_event, code: number) => callback(code));
  },
});
