import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import { join } from "node:path";

/**
 * 窗口宿主进程管理（§8.4g 拓扑）：每窗口一个 utilityProcess host（每会话一进程，注 D）。
 * - 数据面：MessageChannelMain 双端口——port2 转交 host、port1 给 renderer 或本地消费，
 *   main 不过桥（零中转拷贝）
 * - 生命周期绑定**窗口**而非 renderer 加载周期：reload 只调 attachPort 重挂，
 *   host 与会话不动（zcode 教训，§8.4g 复审①）
 * - 退出：先 host.kill() 前给 ≥3.5s 优雅期（host 侧全端口关闭会自行结算退出，
 *   这里兜底强杀防进程树孤儿——zcode 同款参数）
 */

/** host 入口产物（@kcode/host build 产出的单文件 CJS） */
function hostBundlePath(): string {
  return join(__dirname, "../../host/dist/port.cjs");
}

export interface HostHandle {
  child: UtilityProcess;
  /** 重挂一个新端口到存活的 host（reload / smoke 各自调用） */
  attachPort(): MessagePortMain;
  /** 优雅退出：host 自行结算（全端口关闭）或 3.5s 后强杀 */
  dispose(): Promise<void>;
}

export function spawnHost(onExit: (code: number) => void): HostHandle {
  const child = utilityProcess.fork(hostBundlePath(), [], {
    serviceName: "kcode-host",
    stdio: "pipe",
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[host] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[host] ${d}`));
  child.on("exit", (code) => onExit(code));

  return {
    child,
    attachPort(): MessagePortMain {
      const { port1, port2 } = new MessageChannelMain();
      child.postMessage({ type: "attach" }, [port2]);
      return port1;
    },
    async dispose(): Promise<void> {
      if (child.pid === undefined) return;
      const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
      child.kill();
      const graceful = new Promise<void>((resolve) => setTimeout(resolve, 3_500));
      await Promise.race([exited, graceful]);
      if (child.pid !== undefined) {
        child.kill(); // 兜底强杀
      }
    },
  };
}
