import type {
  HookRunner,
  PermissionAsker,
  PermissionEngine,
  Tool,
  ToolOutput,
} from "@kcode/contracts";

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
    private readonly cwd?: string,
    private readonly asker?: PermissionAsker,
    private readonly now: () => number = Date.now,
  ) {}

  async run(tool: Tool, args: unknown, callId: string): Promise<ToolOutput> {
    const name = tool.definition.name;

    const decision = await this.permissions.decide(tool.definition, args);
    if (decision === "deny") {
      this.audit({
        ts: this.now(),
        sessionId: this.sessionId,
        callId,
        tool: name,
        decision: "deny",
      });
      return { ok: false, output: "", error: "permission denied (deny)" };
    }
    if (decision === "ask") {
      // ask 交互确认：无 asker（headless/automation）按 deny 降级（§5.5）
      const allowed =
        this.asker !== undefined && (await this.asker.confirm({ callId, tool: name, args }));
      if (!allowed) {
        this.audit({
          ts: this.now(),
          sessionId: this.sessionId,
          callId,
          tool: name,
          decision: "ask",
          detail: this.asker === undefined ? "no asker → downgraded to deny" : "user denied",
        });
        return { ok: false, output: "", error: "permission denied (ask)" };
      }
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
      result = await tool.execute(effectiveArgs, { sessionId: this.sessionId, cwd: this.cwd });
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
