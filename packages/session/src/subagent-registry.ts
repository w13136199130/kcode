import type { AgentLoop } from "@kcode/core";

/**
 * 子代理句柄注册表（N3D-2）：SendMessage 的寻址基础设施。
 * 与 BackgroundTaskRegistry（tools 层，任务元数据——task_output/面板消费）职责分离：
 * 本表持有 AgentLoop 引用（session 层才允许依赖 core），供 steer/续跑寻址。
 * 终态句柄 LRU 上限——单进程内存自管（zcode 由 runtime 生命周期托管，无此问题）。
 */

export interface SubagentHandle {
  id: string;
  agentType: string;
  description: string;
  /** 子代理 loop 引用：运行中可 steer；终态后同 loop 开新 run 即"复活"（内存历史无损，优于 zcode resumeFromStore） */
  loop: AgentLoop;
  status: "running" | "finished";
  /** 终止回调（后台子代理的 Esc 连杀通道） */
  kill?: () => void;
}

/** 终态句柄保留上限：超限逐出最旧（注册序）；被逐出的不可再寻址 */
const MAX_FINISHED = 8;

export class SubagentRegistry {
  readonly #byId = new Map<string, SubagentHandle>();

  register(handle: SubagentHandle): void {
    this.#byId.set(handle.id, handle);
  }

  get(id: string): SubagentHandle | undefined {
    return this.#byId.get(id);
  }

  list(): SubagentHandle[] {
    return [...this.#byId.values()];
  }

  markRunning(id: string): void {
    const handle = this.#byId.get(id);
    if (handle !== undefined) {
      handle.status = "running";
    }
  }

  /** 终态登记 + LRU 逐出最旧终态句柄（内存护栏） */
  markTerminal(id: string): void {
    const handle = this.#byId.get(id);
    if (handle === undefined) {
      return;
    }
    handle.status = "finished";
    const finished = this.list().filter((h) => h.status === "finished");
    while (finished.length > MAX_FINISHED) {
      const oldest = finished.shift();
      if (oldest === undefined) {
        break;
      }
      this.#byId.delete(oldest.id);
    }
  }
}
