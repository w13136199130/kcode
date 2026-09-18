import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import { listSessions, loadSessionEvents } from "./resume.js";
import { rebuildHistory } from "./replayer.js";

const SessionsArgs = z.object({
  action: z.enum(["list", "read"]),
  sessionId: z.string().min(1).optional(),
});

const MAX_READ_CHARS = 8000;

/**
 * sessions 工具（§5.3 跨会话读取，本地版）：列出/查阅历史会话。
 * 只读工具；放在 runtime（依赖能力层互引规则，tools 包不得 import runtime）。
 */
export function createSessionsTool(opts: { sessionsDir: string }): Tool {
  return {
    definition: {
      name: "sessions",
      description:
        "查看历史会话：action=list 列出（最近优先）；action=read 需要 sessionId，返回浓缩转写（用户/助手/工具首行）",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "read"] },
          sessionId: { type: "string", description: "read 时的会话 id（list 结果中的精确 id）" },
        },
        required: ["action"],
      },
      readOnly: true,
    },
    async execute(input) {
      const parsed = SessionsArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const { action, sessionId } = parsed.data;
      const summaries = await listSessions(opts.sessionsDir);

      if (action === "list") {
        if (summaries.length === 0) {
          return { ok: true, output: "（无历史会话）" };
        }
        const lines = summaries.map(
          (s, i) =>
            `${i + 1}. ${s.sessionId} · ${new Date(s.modifiedAt).toLocaleString()} · ${s.turns} 轮 · ${s.preview}`,
        );
        return { ok: true, output: `共 ${summaries.length} 个会话（最近优先）\n${lines.join("\n")}` };
      }

      if (sessionId === undefined) {
        return { ok: false, output: "", error: "action=read 需要 sessionId（先用 list 查看）" };
      }
      const target = summaries.find((s) => s.sessionId === sessionId);
      if (target === undefined) {
        return { ok: false, output: "", error: `会话不存在: ${sessionId}` };
      }
      const events = await loadSessionEvents(target.filePath);
      const history = rebuildHistory(events);
      const lines: string[] = [];
      let used = 0;
      for (const m of history) {
        const prefix = m.role === "user" ? "👤" : m.role === "assistant" ? "🤖" : "⚙";
        const line = `${prefix} ${m.content.split("\n")[0]?.slice(0, 120) ?? ""}`;
        if (used + line.length > MAX_READ_CHARS) {
          lines.push("（截断：超出读取长度）");
          break;
        }
        used += line.length;
        lines.push(line);
      }
      return {
        ok: true,
        output: `会话 ${sessionId}（${target.turns} 轮）浓缩转写：\n${lines.join("\n")}`,
      };
    },
  };
}
