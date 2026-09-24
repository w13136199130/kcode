import { join } from "node:path";
import type {
  AskPreviewPayload,
  PermissionAnswer,
  PermissionMode,
  RunStatus,
  SessionEvent,
  StructuredQuestion,
} from "@kcode/contracts";
import { buildAskPreview } from "@kcode/tools";
import {
  composeSession,
  resolveResumeHistory,
  trustProject,
  type ComposedSession,
  type PlanVerdict,
} from "@kcode/session";
import { listSessions } from "@kcode/runtime";
import type { Runtime } from "./bootstrap.js";

/**
 * 本地会话句柄（单进程）：引擎内嵌 CLI 进程组装（composeSession），
 * 会话事件照旧落 JSONL——resume/回放/rewind 语义不变。
 */
export interface SessionHandle {
  /** 运行入口：发送消息并等待本轮完成 */
  loop: {
    run(input: string, opts?: { images?: string[] }): Promise<{ sessionId: string; turns: number; toolCalls: number; status: RunStatus }>;
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
  /** !命令 用户直执行（不经 LLM；结果仅显示） */
  runBash(command: string, timeoutMs?: number): Promise<{ ok: boolean; output: string; error?: string; durationMs: number } | null>;
  /** /mcp：MCP 服务器接入状态 */
  mcpStatus(): Promise<{ name: string; transport: string; tools: number; ok: boolean }[] | null>;
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

export interface LocalSessionOptions {
  runtime: Runtime;
  model: string;
  cwd: string;
  /** 续接来源：会话 id / 前缀 / "latest"（本地解析与重建历史） */
  resumeFrom?: string;
  onEvent?: (event: SessionEvent) => void;
  onDelta?: (delta: string) => void;
  /** 思考过程增量（reasoning 模型）：灰色斜体实时渲染 */
  onReasoning?: (delta: string) => void;
  onNotice?: (message: string) => void;
  /** 权限确认（preview 为写/编辑类 diff，本地补齐） */
  asker?: {
    confirm(call: {
      callId: string;
      tool: string;
      args: unknown;
      preview?: AskPreviewPayload;
    }): Promise<boolean | PermissionAnswer>;
  };
  askUser?: { ask: (question: StructuredQuestion) => Promise<string[]> };
  /** 计划批准交互（plan_submit 工具）：渲染计划全文 + 批准菜单 */
  onPlanApproval?: (payload: {
    plan: string;
    question: StructuredQuestion;
    reply: (labels: string[]) => void;
  }) => void;
}

/** 计划批准三选项 */
const PLAN_OPTIONS: { label: string; description: string }[] = [
  { label: "批准并执行", description: "切换到执行模式，按计划执行" },
  { label: "继续研究", description: "留在计划模式，补充调研后重新提交" },
  { label: "放弃", description: "放弃该计划，等待新指示" },
];

/**
 * 建立本地会话：进程内组装引擎（composeSession），事件/增量/交互以回调直连界面。
 * resume 由本地从 JSONL 重建。
 */
export async function createSession(opts: LocalSessionOptions): Promise<SessionHandle> {
  const kcodeHomeDir = opts.runtime.kcodeHomeDir;
  const resume =
    opts.resumeFrom !== undefined
      ? (await resolveResumeHistory(kcodeHomeDir, opts.resumeFrom, opts.cwd)) ?? undefined
      : undefined;
  if (opts.resumeFrom !== undefined && resume === undefined) {
    throw new Error(`未找到会话「${opts.resumeFrom}」（/sessions 查看清单）`);
  }
  if (resume !== undefined && resume.messages.length > 0) {
    opts.onNotice?.(`已续接历史（${resume.messages.length} 条消息）`);
  }

  const baseAsker = opts.asker;
  const composed: ComposedSession = await composeSession({
    llmFactory: (model) => opts.runtime.router.resolve(model),
    model: opts.model,
    cwd: opts.cwd,
    kcodeHomeDir,
    resumeFrom: resume?.messages,
    resumeUsage: resume?.usage,
    onEvent: opts.onEvent,
    onDelta: opts.onDelta,
    onReasoning: opts.onReasoning,
    onNotice: opts.onNotice,
    // 权限确认：本地补 diff 预览后交界面
    asker:
      baseAsker === undefined
        ? undefined
        : {
            confirm: async (call) => {
              const preview = await buildAskPreview(call.tool, call.args, {
                sessionId: call.callId,
                cwd: opts.cwd,
              }).catch(() => undefined);
              return baseAsker.confirm({ ...call, ...(preview !== undefined ? { preview } : {}) });
            },
          },
    askUser: opts.askUser,
    planAsker:
      opts.onPlanApproval === undefined
        ? undefined
        : {
            ask: (plan) =>
              new Promise<PlanVerdict>((resolve) => {
                opts.onPlanApproval!({
                  plan,
                  question: { question: "以上是模型提交的执行计划，是否批准执行？", options: PLAN_OPTIONS, multiSelect: false },
                  reply: (labels) => {
                    const picked = labels[0] ?? "";
                    resolve(picked === "批准并执行" ? "approved" : picked === "继续研究" ? "revise" : "abandon");
                  },
                });
              }),
          },
  });

  return {
    sessionId: composed.sessionId,
    loop: {
      run: (input, runOpts) => composed.loop.run(input, runOpts ?? {}),
    },
    abort: () => composed.abort(),
    setMode: (mode) => {
      composed.setMode(mode);
    },
    setModel: async (model) => {
      try {
        await composed.setModel(model);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    models: async () => {
      const models = opts.runtime.models;
      return {
        ...(models.default !== undefined ? { default: models.default } : {}),
        providers: Object.keys(models.providers ?? {}),
      };
    },
    listSkills: async () => composed.listSkills().map((s) => ({ name: s.name, description: s.description })),
    skillBody: (name) => composed.skillBody(name),
    listSessions: async () => {
      const summaries = await listSessions(join(kcodeHomeDir, "cli", "sessions"));
      return summaries.slice(0, 10).map((s) => ({ sessionId: s.sessionId, preview: s.preview, turns: s.turns }));
    },
    listCommands: () => composed.listCommands(),
    expandCommand: (name, args) => composed.expandCommand(name, args),
    trustProject: () => trustProject(opts.cwd, kcodeHomeDir),
    listPersistentGrants: () => composed.listPersistentGrants(),
    clearPersistentGrants: async () => {
      await composed.clearPersistentGrants();
      return true;
    },
    usage: async () => {
      const u = composed.usageSummary();
      return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, calls: u.calls };
    },
    rewindPoints: () => composed.listRewindPoints(),
    rewind: async (eventIndex) => {
      try {
        await composed.rewind(eventIndex);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    compact: async () => {
      try {
        const r = await composed.compactNow();
        return r === null ? { dropped: 0, summaryChars: 0 } : { dropped: r.dropped, summaryChars: r.summaryChars };
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    context: async () => composed.contextStats(),
    runBash: (command, timeoutMs) => composed.runBash(command, timeoutMs),
    mcpStatus: async () => composed.mcpInfo().servers,
  };
}
