import type {
  HookRunner,
  PermissionDecision,
  PermissionEngine,
  SessionEvent,
  SessionSink,
  Tool,
  ToolRegistry,
} from "@kcode/contracts";
import type { AuditRecord } from "../core/pipeline.js";

/** 内存事件池：测试/evals 注入 core 的 SessionSink 实现 */
export class MemorySink implements SessionSink {
  readonly events: SessionEvent[] = [];
  append(event: SessionEvent): void {
    this.events.push(event);
  }
}

export class MemoryAudit {
  readonly records: AuditRecord[] = [];
  readonly sink = (record: AuditRecord): void => {
    this.records.push(record);
  };
}

export const allowAll: PermissionEngine = {
  decide: async (): Promise<PermissionDecision> => "allow",
};
export const denyAll: PermissionEngine = {
  decide: async (): Promise<PermissionDecision> => "deny",
};

export const noHooks: HookRunner = {
  preToolUse: async () => ({ veto: false }),
  postToolUse: async () => {},
};

export class InMemoryToolRegistry implements ToolRegistry {
  #tools: Tool[];

  constructor(tools: Tool[]) {
    this.#tools = tools;
  }

  list(): Tool[] {
    return this.#tools;
  }

  get(name: string): Tool | undefined {
    return this.#tools.find((t) => t.definition.name === name);
  }
}
