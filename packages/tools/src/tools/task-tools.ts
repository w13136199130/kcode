import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "@kcode/contracts";
import type { BackgroundTaskRegistry } from "./bash.js";

/**
 * 后台任务控制工具对（工具面补全，对标 zcode TaskOutput/TaskStop）：
 * bash 的 runInBackground 只返回"任务号 + 日志路径"，模型此前没有任何途径回看输出
 * 或主动终止——长任务场景只能靠用户自己看文件。两个工具补齐显式控制面：
 * task_output 只读放行；task_stop 与 bash 同档（default=ask），plan 档按非只读拒绝。
 */

const TaskOutputArgs = z.object({
  taskId: z.string().min(1),
  /** 日志尾部行数（默认 40，上限 500——防把上下文灌爆） */
  tailLines: z.number().int().positive().max(500).optional(),
});

const TaskStopArgs = z.object({
  taskId: z.string().min(1),
});

const WaitArgs = z.object({
  taskId: z.string().min(1),
  /** 等待上限（毫秒，默认 30s，最大 120s；超时返回仍在运行，可再次 wait/task_output） */
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

function stateOf(task: { status: string; exitCode?: number }): string {
  return task.status === "running"
    ? "运行中"
    : task.status === "done"
      ? `已完成（exit ${task.exitCode ?? 0}）`
      : `失败（exit ${task.exitCode ?? -1}）`;
}

function formatTaskLine(task: { id: string; status: string; command: string; startedAt: number; exitCode?: number }, now = Date.now()): string {
  const elapsed = task.status === "running" ? ` · ${Math.round((now - task.startedAt) / 1000)}s` : "";
  return `- ${task.id} · ${stateOf(task)}${elapsed} · ${task.command.slice(0, 80)}`;
}

/** 运行中任务的日志尾部（运行中日志是追加流，读到的是当时的快照） */
async function tailOf(taskId: string, logPath: string, lines: number): Promise<string> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return "（日志暂不可读）";
  }
  if (text === "") {
    return "（日志为空——命令可能还没产生输出）";
  }
  // 子代理（N3D-1）的"日志"是其会话 JSONL：逐行解析成人类可读活动摘要
  if (taskId.startsWith("sub_")) {
    const rendered = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-lines)
      .map((line) => {
        try {
          const e = JSON.parse(line) as { type?: string; content?: string; tool?: string; reason?: string };
          if (e.type === "assistant_message") return `🤖 ${(e.content ?? "").split("\n")[0]?.slice(0, 80) ?? ""}`;
          if (e.type === "tool_call") return `⚡ ${e.tool ?? ""}`;
          if (e.type === "user_message") return `👤 ${(e.content ?? "").split("\n")[0]?.slice(0, 60) ?? ""}`;
          if (e.type === "session_end") return `· 本轮结束（${e.reason ?? ""}）`;
          return `· ${e.type ?? "事件"}`;
        } catch {
          return "·（不可解析行）";
        }
      });
    return rendered.join("\n");
  }
  return text.split("\n").slice(-lines).join("\n");
}

export function createTaskTools(registry: BackgroundTaskRegistry): [Tool, Tool, Tool, Tool] {
  const taskOutput: Tool = {
    definition: {
      name: "task_output",
      description:
        "查看后台任务（bash runInBackground 启动）的状态与输出：返回状态/退出码/命令与日志尾部；长任务可反复调用作进度轮询",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "后台任务 id（bg_ 前缀，来自 bash 的返回）" },
          tailLines: { type: "number", description: "日志尾部行数，默认 40，上限 500" },
        },
        required: ["taskId"],
      },
      readOnly: true,
      permission: { default: "allow" },
      timeoutMs: 15_000,
      resultBudget: 4096,
    },
    async execute(input) {
      const parsed = TaskOutputArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const task = registry.get(parsed.data.taskId);
      if (task === undefined) {
        return { ok: false, output: "", error: `未知任务 ${parsed.data.taskId}（本会话的后台任务才有记录）` };
      }
      const tail = await tailOf(task.id, task.logPath, parsed.data.tailLines ?? 40);
      // 终态读取即认领送达（N3D-1 幂等）：模型已看到结果，后台子代理完成时不再重复通知
      if (task.status !== "running") {
        registry.update(task.id, { notified: true });
      }
      const state = stateOf(task);
      return {
        ok: true,
        output: `任务 ${task.id} · ${state} · 命令：${task.command}\n日志尾部（${task.logPath}）：\n${tail}`,
      };
    },
  };

  const taskStop: Tool = {
    definition: {
      name: "task_stop",
      description: "终止运行中的后台任务（幂等：已完成或不存在的任务返回说明而非报错）",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "后台任务 id（bg_ 前缀）" },
        },
        required: ["taskId"],
      },
      readOnly: false,
      // 终止进程与 bash 同风险级：默认询问；plan 档非只读自动拒绝
      permission: { default: "ask" },
      timeoutMs: 15_000,
    },
    async execute(input) {
      const parsed = TaskStopArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const task = registry.get(parsed.data.taskId);
      if (task === undefined) {
        return { ok: false, output: "", error: `未知任务 ${parsed.data.taskId}` };
      }
      if (task.status !== "running") {
        return { ok: true, output: `任务 ${task.id} 已结束（${task.status}），无需终止` };
      }
      // stop 只发信号；状态翻转由子进程 close 回调统一回写（单一事实源）
      const sent = registry.stop(parsed.data.taskId);
      return {
        ok: true,
        output: sent ? `已向任务 ${task.id} 发送终止信号（命令：${task.command.slice(0, 60)}）` : `任务 ${task.id} 刚刚结束，无需终止`,
      };
    },
  };

  const taskList: Tool = {
    definition: {
      name: "task_list",
      description:
        "列出本会话全部后台任务（bash runInBackground 与后台子代理）：id/状态/耗时/命令；长任务轮询前先看清单",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      permission: { default: "allow" },
      timeoutMs: 10_000,
    },
    async execute() {
      const tasks = registry.list();
      if (tasks.length === 0) {
        return { ok: true, output: "（本会话暂无后台任务）" };
      }
      return {
        ok: true,
        output: `后台任务（${tasks.length}）：\n${tasks.map((t) => formatTaskLine(t)).join("\n")}`,
      };
    },
  };

  const taskWait: Tool = {
    definition: {
      name: "task_wait",
      description:
        "等待后台任务结束（默认最多 30s，上限 120s）：返回终态与日志尾部；超时仍运行则返回当前状态，可再次调用或改用 task_output",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "后台任务 id（bg_ 或 sub_ 前缀）" },
          timeoutMs: { type: "number", description: "等待上限毫秒（默认 30000，最大 120000）" },
        },
        required: ["taskId"],
      },
      readOnly: true,
      permission: { default: "allow" },
      timeoutMs: 125_000,
      resultBudget: 4096,
    },
    async execute(input) {
      const parsed = WaitArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const { taskId } = parsed.data;
      const timeoutMs = parsed.data.timeoutMs ?? 30_000;
      const deadline = Date.now() + timeoutMs;
      let task = registry.get(taskId);
      if (task === undefined) {
        return { ok: false, output: "", error: `未知任务 ${taskId}（本会话的后台任务才有记录）` };
      }
      while (task.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        task = registry.get(taskId);
        if (task === undefined) {
          return { ok: false, output: "", error: `任务 ${taskId} 已从注册表移除` };
        }
      }
      const tail = await tailOf(task.id, task.logPath, 40);
      if (task.status === "running") {
        return { ok: true, output: `任务 ${task.id} 仍在运行（已等待 ${Math.round(timeoutMs / 1000)}s）\n日志尾部：\n${tail}` };
      }
      registry.update(task.id, { notified: true });
      return { ok: true, output: `任务 ${task.id} · ${stateOf(task)}\n日志尾部：\n${tail}` };
    },
  };

  return [taskOutput, taskStop, taskList, taskWait];
}
