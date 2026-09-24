import type { SessionEvent } from "@kcode/contracts";

type Handler = (event: SessionEvent) => void | Promise<void>;

/** 事件总线（§5.1）：loop 每步事件除落盘外可选广播给订阅方（TUI/遥测） */
export class EventBus {
  #handlers = new Set<Handler>();

  on(handler: Handler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async emit(event: SessionEvent): Promise<void> {
    for (const handler of this.#handlers) {
      await handler(event);
    }
  }
}
