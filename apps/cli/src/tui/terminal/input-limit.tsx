import { useStdin } from "ink";

/**
 * Ink 4 的 useInput 每注册一个监听器到内部 input EventEmitter；kcode 的全局键位、
 * 输入区与各覆盖层同时挂载时超过 Node 默认的 10，启动会刷 MaxListenersExceededWarning。
 * 这不是泄漏（覆盖层卸载时会 removeListener），只是监听器上限过低；在渲染期抬高上限，
 * 避免警告淹没真正的启动错误。Ink 未来移除 internal_eventEmitter 时自动跳过。
 */
export function useInputListenerLimit(): void {
  const stdin = useStdin() as unknown as {
    internal_eventEmitter?: { setMaxListeners: (limit: number) => void };
  };
  const emitter = stdin.internal_eventEmitter;
  if (emitter !== undefined && typeof emitter.setMaxListeners === "function") {
    emitter.setMaxListeners(50);
  }
}

/** 独立组件形态（测试/嵌入用）；KcodeApp 直接调用 useInputListenerLimit() */
export function RaiseInputListenerLimit() {
  useInputListenerLimit();
  return null;
}
