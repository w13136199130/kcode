import type { HookRunner, PermissionEngine, Tool, ToolOutput } from "@kcode/contracts";

export interface AuditRecord {
  ts: number;
  sessionId: string;
  callId: string;
  tool: string;
  decision: "allow" | "ask" | "deny" | "veto" | "executed" | "error";
  detail?: string;
}

export type AuditSink = (record: AuditRecord) => void;

/**
 * 工具调用管线（§5.1，顺序定死）：
 * permissions（纯本地裁决，快）→ pre_tool_use hooks（可 veto/改参）→ 执行 → post_tool_use hooks → 审计。
 */
export class ToolPipeline {
  constructor(
    private readonly permissions: PermissionEngine,
    private readonly hooks: HookRunner,
    private readonly audit: AuditSink,
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async run(tool: Tool, args: unknown, callId: string): Promise<ToolOutput> {
    const name = tool.definition.name;

    const decision = await this.permissions.decide(tool.definition, args);
    if (decision === "deny" || decision === "ask") {
      // P0：ask 尚无交互确认（P1 CLI 接入），按 deny 处理并留审计（§5.5 同款降级语义）
      this.audit({
        ts: this.now(),
        sessionId: this.sessionId,
        callId,
        tool: name,
        decision,
        detail: decision === "ask" ? "downgraded to deny in P0" : undefined,
      });
      return { ok: false, output: "", error: `permission denied (${decision})` };
    }

    const pre = await this.hooks.preToolUse({ callId, tool: name, args });
    if (pre.veto) {
      this.audit({
        ts: this.now(),
        sessionId: this.sessionId,
        callId,
        tool: name,
        decision: "veto",
        detail: pre.reason,
      });
      return {
        ok: false,
        output: "",
        error: `blocked by pre_tool_use hook${pre.reason !== undefined ? `: ${pre.reason}` : ""}`,
      };
    }

    const effectiveArgs = pre.args ?? args;
    let result: ToolOutput;
    try {
      result = await tool.execute(effectiveArgs, { sessionId: this.sessionId });
    } catch (err) {
      result = { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
    await this.hooks.postToolUse({ callId, tool: name, args: effectiveArgs }, result);
    this.audit({
      ts: this.now(),
      sessionId: this.sessionId,
      callId,
      tool: name,
      decision: result.ok ? "executed" : "error",
      detail: result.error,
    });
    return result;
  }
}
