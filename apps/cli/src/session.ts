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
  /** 中断当前运行（Esc）：流式停止、未开始的工具调用取消 */
  abort(): void;
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
  /** 本项目持久放行清单（/permissions） */
  listPersistentGrants(): Promise<string[]>;
  /** 清空本项目持久放行（/permissions）；成功返回 true */
  clearPersistentGrants(): Promise<boolean>;
  /** 会话累计用量（含 resume 续接历史；/cost） */
  usage(): Promise<{ inputTokens: number; outputTokens: number; calls: number } | null>;
  /** /rewind 回退点清单（每个 user_message 一项） */
  rewindPoints(): Promise<{ eventIndex: number; preview: string; ts: number; fileChanges: number }[]>;
  /** 回退到某提问之前（恢复文件快照 + 截断对话）；失败返回错误信息 */
  rewind(eventIndex: number): Promise<string | null>;
  /** /compact 手动压缩（历史过短未触发时 dropped=0）；失败返回错误信息 */
  compact(): Promise<{ dropped: number; summaryChars: number } | string>;
  /** /context 上下文占用 */
  context(): Promise<{
    model: string;
    contextWindow: number;
    historyTokens: number;
    historyBudget: number;
    systemTokens: number;
    pinnedAnchor: boolean;
  } | null>;
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
  /** 计划批准交互（plan_submit 工具推送的 plan_question）：渲染计划全文 + 批准菜单 */
  onPlanApproval?: (payload: {
    plan: string;
    question: StructuredQuestion;
    reply: (labels: string[]) => void;
  }) => void;
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
      // 计划批准走专用通道（渲染计划全文 + 批准菜单）
      if (raw.kind === "plan_question" && opts.onPlanApproval !== undefined) {
        const plan = (raw as unknown as { plan: string }).plan;
        opts.onPlanApproval({
          plan,
          question,
          reply: (labels) => {
            opts.client.replyQuestion(questionId, labels);
          },
        });
        return;
      }
      void opts.askUser!.ask(question).then((labels) => {
        opts.client.replyQuestion(questionId, labels);
      });
    });
  } else if (opts.onPlanApproval !== undefined) {
    // 无 ask_user 端口也要接计划批准（plan_submit 独立于 ask_user 工具）
    opts.client.onQuestion((questionId, raw) => {
      if (raw.kind !== "plan_question") return;
      const plan = (raw as unknown as { plan: string }).plan;
      const question = raw as unknown as { question: string; options: { label: string; description?: string }[]; multiSelect?: boolean };
      opts.onPlanApproval!({
        plan,
        question,
        reply: (labels) => {
          opts.client.replyQuestion(questionId, labels);
        },
      });
    });
  }

  const runDoneWaiters = new Set<{
    resolve: (summary: { sessionId: string; turns: number; toolCalls: number }) => void;
    reject: (err: Error) => void;
  }>();
  opts.client.onRunDone((sid, turns, toolCalls) => {
    if (sid === sessionId) {
      for (const waiter of runDoneWaiters) {
        waiter.resolve({ sessionId: sid, turns, toolCalls });
      }
      runDoneWaiters.clear();
    }
  });
  // daemon 掉线：未决运行立即失败，界面解除 busy 并提示续接（历史在 JSONL，可 --resume）
  opts.client.onClose(() => {
    for (const waiter of runDoneWaiters) {
      waiter.reject(new Error("与守护进程的连接已断开（daemon 可能已退出）"));
    }
    runDoneWaiters.clear();
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
        return new Promise((resolvePromise, rejectPromise) => {
          runDoneWaiters.add({ resolve: resolvePromise, reject: rejectPromise });
        });
      },
    },
    abort: () => {
      void opts.client.request({ method: "session_abort", sessionId }).catch(() => {
        // daemon 已不可达时忽略（掉线路径由 onClose 兜底）
      });
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
    listPersistentGrants: async () => {
      const response = await opts.client
        .request({ method: "permissions_list", sessionId })
        .catch(() => null);
      if (response === null || response.kind !== "permissions") {
        return [];
      }
      return response.patterns;
    },
    clearPersistentGrants: async () => {
      const response = await opts.client
        .request({ method: "permissions_clear", sessionId })
        .catch(() => null);
      return response !== null && response.kind === "accepted";
    },
    usage: async () => {
      const response = await opts.client
        .request({ method: "session_usage", sessionId })
        .catch(() => null);
      if (response === null || response.kind !== "usage") {
        return null;
      }
      return {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        calls: response.calls,
      };
    },
    rewindPoints: async () => {
      const response = await opts.client
        .request({ method: "session_rewind_points", sessionId })
        .catch(() => null);
      if (response === null || response.kind !== "rewind_points") {
        return [];
      }
      return response.points;
    },
    compact: async () => {
      const response = await opts.client
        .request({ method: "session_compact", sessionId })
        .catch((err: Error) => err);
      if (response instanceof Error) {
        return response.message;
      }
      if (response.kind === "compact_ok") {
        return { dropped: response.dropped, summaryChars: response.summaryChars };
      }
      return response.kind === "error" ? response.message : "未知错误";
    },
    context: async () => {
      const response = await opts.client
        .request({ method: "session_context", sessionId })
        .catch(() => null);
      if (response === null || response.kind !== "context_info") {
        return null;
      }
      return {
        model: response.model,
        contextWindow: response.contextWindow,
        historyTokens: response.historyTokens,
        historyBudget: response.historyBudget,
        systemTokens: response.systemTokens,
        pinnedAnchor: response.pinnedAnchor,
      };
    },
    rewind: async (eventIndex: number) => {
      const response = await opts.client
        .request({ method: "session_rewind", sessionId, eventIndex })
        .catch((err: Error) => err);
      if (response instanceof Error) {
        return response.message;
      }
      if (response.kind === "rewind_ok") {
        return null;
      }
      return response.kind === "error" ? response.message : "未知错误";
    },
  };
}
