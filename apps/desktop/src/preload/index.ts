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
  /**
   * 宿主帧到达（一消息一 JSON 字符串，host-protocol）。
   * 返回退订函数——StrictMode 双挂载会重复订阅（每条事件处理两遍=界面全双份，M2a 实测），
   * 订阅方必须在 cleanup 里退订。
   */
  onMessage(callback: (data: string) => void): () => void {
    messageHandlers.add(callback);
    return () => {
      messageHandlers.delete(callback);
    };
  },
  /** 发送宿主帧（JSON 字符串） */
  send(data: string): void {
    port?.postMessage(data);
  },
  /** 宿主进程退出通知（崩溃/结束/断连兜底）——renderer 据此提示重连或开新会话 */
  onHostExit(callback: (code: number) => void): void {
    ipcRenderer.on("kcode:host-exit", (_event, code: number) => callback(code));
  },
  /** 用户级配置的默认模型引用（主进程读 config.json——renderer 无文件访问） */
  getDefaultModel(): Promise<string | null> {
    return ipcRenderer.invoke("kcode:default-model");
  },
  /** 新建会话 = 新窗口（窗口=会话的既定拓扑） */
  newWindow(): void {
    ipcRenderer.send("kcode:new-window");
  },
  /** 默认工作目录（M2a = homedir；工作区选择器 M2b） */
  getDefaultCwd(): Promise<string> {
    return ipcRenderer.invoke("kcode:default-cwd");
  },
  /** 打开系统文件夹选择器；取消返回 null（D0-07） */
  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("kcode:pick-directory");
  },
  /** 系统通知（renderer 仅在窗口失焦时发送——去重纪律在调用侧） */
  notify(title: string, body: string): void {
    ipcRenderer.send("kcode:notify", { title, body });
  },
  /** 应用版本（构建注入 KCODE_VERSION） */
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke("kcode:app-version");
  },
});

/** preload 内部端口对象的类型（DOM MessagePort 的最小用面） */
type MessagePort = {
  postMessage(data: string): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};
