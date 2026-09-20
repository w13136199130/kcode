import type {
  AskPreviewPayload,
  PermissionAnswer,
  PermissionMode,
  SessionEvent,
  StructuredQuestion,
} from "@kcode/contracts";
import type { DaemonClient } from "./daemon-client.js";

/**
 * CLI 侧会话句柄：全部操作经本地通道转发给守护进程，
 * CLI 自身不再组装任何引擎组件（守护进程是唯一组装点）。
 */
export interface SessionHandle {
  /** 远程会话的运行入口：发送消息并等待本轮完成 */
  loop: {
    run(input: string, opts?: { images?: string[] }): Promise<{ sessionId: string; turns: number; toolCalls: number }>;
  };
  sessionId: string;
  /** 切换权限模式四档（plan/default/acceptEdits/fullAccess） */
  setMode(mode: PermissionMode): void;
  /** 运行期换模型（/model）：成功返回 null，失败返回错误信息 */
  setModel(model: string): Promise<string | null>;
  models(): Promise<{ default?: string; providers: string[] }>;
  listSkills(): Promise<{ name: string; description: string }[]>;
  skillBody(name: string): Promise<string | null>;
  listSessions(): Promise<{ sessionId: string; preview: string; turns: number }[]>;
  listCommands(): { name: string; source: "project" | "user" }[];
  expandCommand(name: string, args: string): Promise<string | null>;
  trustProject(): Promise<void>;
}

export interface RemoteSessionOptions {
  client: DaemonClient;
  model: string;
  cwd: string;
  /** 续接来源：会话 id / 前缀 / "latest"（由守护进程解析与重建历史） */
  resumeFrom?: string;
  onEvent?: (event: SessionEvent) => void;
  onDelta?: (delta: string) => void;
  /** 思考过程增量（reasoning 模型）：灰色斜体实时渲染 */
  onReasoning?: (delta: string) => void;
  onNotice?: (message: string) => void;
  /** 交互确认由守护进程推送过来，经此回调交给界面（preview 为写/编辑类 diff） */
  asker?: {
    confirm(call: {
      callId: string;
      tool: string;
      args: unknown;
      preview?: AskPreviewPayload;
    }): Promise<boolean | PermissionAnswer>;
  };
  askUser?: { ask: (question: StructuredQuestion) => Promise<string[]> };
}

/**
 * 建立远程会话：在守护进程侧组装引擎，本地只保留协议订阅。
 * 事件/增量/通知按会话 id 过滤后交给回调；run 的完成以 run_done 为准。
 */
export async function createSession(opts: RemoteSessionOptions): Promise<SessionHandle> {
  const created = await opts.client.request({
    method: "session_create",
    cwd: opts.cwd,
    model: opts.model,
    ...(opts.resumeFrom !== undefined ? { resumeFrom: opts.resumeFrom } : {}),
  });
  if (created.kind !== "session_ok") {
    throw new Error("会话创建失败");
  }
  const sessionId = created.sessionId;
  if (created.resumedMessages > 0) {
    opts.onNotice?.(`已续接历史（${created.resumedMessages} 条消息）`);
  }

  // 会话事件订阅（按会话 id 过滤）
  opts.client.onEvent((sid, raw) => {
    if (sid === sessionId) {
      opts.onEvent?.(raw as unknown as SessionEvent);
    }
  });
  opts.client.onDelta((sid, text, channel) => {
    if (sid === sessionId) {
      if (channel === "reasoning") {
        opts.onReasoning?.(text);
      } else {
        opts.onDelta?.(text);
      }
    }
  });
  opts.client.onNotice((message) => {
    opts.onNotice?.(message);
  });
  // 交互确认：守护进程请求 → 界面回调 → 应答（含会话级放行标记）回传
  if (opts.asker !== undefined) {
    opts.client.onAsk((callId, tool, args, preview) => {
      void Promise.resolve(opts.asker!.confirm({ callId, tool, args, preview })).then((answer) => {
        const normalized =
          typeof answer === "boolean" ? { allowed: answer } : answer;
        opts.client.replyAsk(callId, normalized.allowed, normalized.scope);
      });
    });
  }
  if (opts.askUser !== undefined) {
    opts.client.onQuestion((questionId, raw) => {
      const question = raw as unknown as { question: string; options: { label: string; description?: string }[]; multiSelect?: boolean };
      void opts.askUser!.ask(question).then((labels) => {
        opts.client.replyQuestion(questionId, labels);
      });
    });
  }

  const runDoneWaiters = new Set<(summary: { sessionId: string; turns: number; toolCalls: number }) => void>();
  opts.client.onRunDone((sid, turns, toolCalls) => {
    if (sid === sessionId) {
      for (const waiter of runDoneWaiters) {
        waiter({ sessionId: sid, turns, toolCalls });
      }
      runDoneWaiters.clear();
    }
  });

  // 命令清单预取：必须在 return 之前执行（写在 return 后是永不运行的死代码，
  // 且闭包引用未初始化的 let 会触发 TDZ 报错——该 bug 自 P1 潜伏至今）
  let commandCache: { name: string; source: "project" | "user" }[] = [];
  void opts.client
    .request({ method: "commands_list", cwd: opts.cwd })
    .then((response) => {
      if (response.kind === "commands") {
        commandCache = response.commands;
      }
    })
    .catch(() => {
      // 命令列表获取失败不影响主流程
    });

  return {
    sessionId,
    loop: {
      run: async (input, runOpts) => {
        await opts.client.request({
          method: "session_send",
          sessionId,
          content: input,
          ...(runOpts?.images !== undefined ? { images: runOpts.images } : {}),
        });
        return new Promise((resolvePromise) => {
          runDoneWaiters.add(resolvePromise);
        });
      },
    },
    setMode: (mode) => {
      void opts.client.request({ method: "session_mode", sessionId, mode }).catch(() => {
        // 模式切换失败不阻断界面（头部显示以下次成功切换为准）
      });
    },
    setModel: async (model) => {
      const response = await opts.client
        .request({ method: "session_set_model", sessionId, model })
        .catch((err: Error) => err);
      if (response instanceof Error) {
        return response.message;
      }
      return response.kind === "accepted" ? null : (("message" in response ? response.message : "未知错误") as string);
    },
    models: async () => {
      const response = await opts.client.request({ method: "models_list" });
      if (response.kind !== "models") {
        return { providers: [] };
      }
      return { ...(response.default !== undefined ? { default: response.default } : {}), providers: response.providers };
    },
    listSkills: async () => {
      const response = await opts.client.request({ method: "skills_list", sessionId });
      if (response.kind !== "skills") {
        return [];
      }
      return response.skills.map((s) => ({ name: s.name, description: s.description }));
    },
    skillBody: async (name) => {
      const response = await opts.client.request({ method: "skill_body", sessionId, name });
      if (response.kind !== "skill_body_ok") {
        return null;
      }
      return response.body;
    },
    listSessions: async () => {
      const response = await opts.client.request({ method: "sessions_list" });
      if (response.kind !== "sessions") {
        return [];
      }
      return response.sessions;
    },
    listCommands: () => {
      // 命令列表在连接期缓存一次即可；此处同步返回由创建时预取
      return commandCache;
    },
    expandCommand: async (name, args) => {
      const response = await opts.client
        .request({ method: "command_expand", cwd: opts.cwd, name, args })
        .catch(() => null);
      if (response === null || response.kind !== "command_expanded") {
        return null;
      }
      return response.template;
    },
    trustProject: async () => {
      await opts.client.request({ method: "session_trust", cwd: opts.cwd });
    },
  };
}
