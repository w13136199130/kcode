import { z } from "zod";
import { TodoItem, type SessionEvent, type SessionSink, type Tool } from "@kcode/contracts";

const TodoArgs = z.object({ todos: z.array(TodoItem) });

export interface TodoToolOptions {
  sessionId: string;
  /** 会话事件落盘（todo_update 进 JSONL，回放可见，§1.1 A 域 Todo） */
  sink?: SessionSink;
}

/** todo 工具：全量替换会话任务清单；同一时刻至多一个 in_progress */
export function createTodoTool(opts: TodoToolOptions): Tool {
  return {
    definition: {
      name: "todo",
      description:
        "维护会话任务清单（全量替换）：每项 { content, status: pending|in_progress|completed, priority: high|medium|low }；同一时刻至多一个 in_progress",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      readOnly: true,
    },
    async execute(input) {
      const parsed = TodoArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const todos = parsed.data.todos;
      if (todos.filter((t) => t.status === "in_progress").length > 1) {
        return { ok: false, output: "", error: "同一时刻至多一个任务 in_progress" };
      }
      const event: SessionEvent = {
        v: 1,
        type: "todo_update",
        ts: Date.now(),
        sessionId: opts.sessionId,
        todos,
      };
      await opts.sink?.append(event);
      const completed = todos.filter((t) => t.status === "completed").length;
      return { ok: true, output: `任务清单已更新（${todos.length} 项 / ${completed} 完成）` };
    },
  };
}
