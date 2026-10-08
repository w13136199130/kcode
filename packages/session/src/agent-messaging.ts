import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import type { SubagentRegistry } from "./subagent-registry.js";

/**
 * 代理间消息工具对（N3D-2 主体，对标 zcode send-message.ts / respond-to-coordinator.ts）：
 * - send_message（父会话工具）：两态投递——运行中子代理 steer 注入下一模型步；
 *   终态子代理同 loop 开新 run（内存复活，优于 zcode 的 resumeFromStore——单进程历史无损）。
 *   非阻塞：只回投递回执，不等回复。
 * - respond_to_coordinator（子代理工具，无条件注入）：异步单向回父——复用 N3D-1 的
 *   notify 通道（父忙入队/父空闲开新 turn + 防伪头），不另建命令类型。
 * 设计修订依据（zcode 源码对照）：kcode 无"空闲存活"态（子代理一次 run 即终态），
 * zcode 三态中的 queued 仅作为 steer 竞态兜底保留在 loop.pendingInputs 内。
 */

/** 子代理侧收到的注入消息头（防伪：与用户输入可区分） */
export const STEER_HEADER = "[SYSTEM MESSAGE - 协调者消息]";

/** 通知防伪头（对标 zcode incoming-message.ts:9）：防不可信内容冒充用户输入 */
export const SUBAGENT_NOTIFICATION_HEADER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

const SendMessageArgs = z.object({
  agentId: z.string().min(1),
  message: z.string().min(1),
});

const RespondArgs = z.object({
  message: z.string().min(1),
});

export function buildSendMessageTool(deps: {
  registry: SubagentRegistry;
}): Tool {
  const knownIds = (): string => deps.registry.list().map((h) => h.id).join("、") || "（无）";
  return {
    definition: {
      name: "send_message",
      description:
        "向子代理发送消息（非阻塞，只回投递回执）：运行中的子代理在下一个模型步收到（steer）；已结束的直接续跑（resumed，保留其完整上下文）。适用于中途补充指示/追问/改派方向。agentId 来自 task 的返回；发错 id 时错误信息会列出当前可寻址清单",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "子代理 id（sub_ 前缀，来自 task 的返回或本工具描述）" },
          message: { type: "string", description: "消息内容（将作为该子代理的输入注入）" },
        },
        required: ["agentId", "message"],
      },
      readOnly: false,
      // 派生会话内消息与 task 同风险级；子代理内部工具仍受各自权限管
      concurrentSafe: true,
      permission: { default: "allow" },
      timeoutMs: 10_000,
    },
    async execute(input) {
      const parsed = SendMessageArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const handle = deps.registry.get(parsed.data.agentId);
      if (handle === undefined) {
        return {
          ok: false,
          output: "",
          error: `未知子代理 ${parsed.data.agentId}（可寻址：${knownIds()}——终态句柄超保留上限会被逐出，此时请派新子代理并附上下文摘要）`,
        };
      }
      const wrapped = `${STEER_HEADER}\n${parsed.data.message}\n（协调者在你工作时发来的消息：完成当前步骤前先处理它）`;
      // 两态投递：运行中 → steer（下一模型步边界进入当前轮）；终态 → 同 loop 新 run（复活）
      if (handle.loop.steer(wrapped)) {
        return { ok: true, output: `已注入（steered）→ ${handle.id}：消息将在其下一个模型步送达` };
      }
      deps.registry.markRunning(handle.id);
      void handle.loop
        .run(wrapped)
        .catch(() => undefined)
        .finally(() => deps.registry.markTerminal(handle.id));
      return {
        ok: true,
        output: `已续跑（resumed）→ ${handle.id}（${handle.agentType}）：以既有上下文开新轮处理该消息，结论经通知送达`,
      };
    },
  };
}

export function buildRespondToCoordinatorTool(deps: {
  childId: string;
  childType: string;
  /** N3D-1 notify 通道：父忙入队 / 父空闲开新 turn（载荷统一防伪头，TUI 📩 分支同源命中） */
  notify: (text: string) => void;
}): Tool {
  return {
    definition: {
      name: "respond_to_coordinator",
      description:
        "向协调者（父会话）异步发送中间发现/提问/部分结论——不阻塞当前任务、不等回复；最终结论仍以任务收尾为准，不能用本工具替代",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "要转达的内容（自包含：协调者看不到你的上下文）" },
        },
        required: ["message"],
      },
      readOnly: true,
      permission: { default: "allow" },
      timeoutMs: 5_000,
    },
    async execute(input) {
      const parsed = RespondArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      deps.notify(
        `${SUBAGENT_NOTIFICATION_HEADER}\n<subagent-message>\n<agent-id>${deps.childId}</agent-id>\n<agent-type>${deps.childType}</agent-type>\n<message>${parsed.data.message}</message>\n</subagent-message>`,
      );
      return { ok: true, output: "已送达协调者（异步，无需等待回复）" };
    },
  };
}
