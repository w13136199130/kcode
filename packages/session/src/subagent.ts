import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  HookRunner,
  LLMProvider,
  PermissionAsker,
  PermissionEngine,
  SessionSink,
  Tool,
  ToolOutput,
  UserPromptPort,
} from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit, MemorySink } from "@kcode/core";
import { AgentLibrary } from "@kcode/extensions";
import { JsonlSessionSink } from "@kcode/runtime";
import { createAskUserTool, type BackgroundTaskRegistry } from "@kcode/tools";
import { buildRespondToCoordinatorTool, SUBAGENT_NOTIFICATION_HEADER } from "./agent-messaging.js";
import type { SubagentRegistry } from "./subagent-registry.js";
import { newId } from "@kcode/shared";

/** 子代理轮次上限（成本护栏；到顶仍返回已有结论并标注不完整） */
export const SUBAGENT_MAX_TURNS = 12;
/**
 * 不活动看门狗（N3D-1，取代 600s 墙钟）：子事件流静默超过此时长即终止——
 * 慢而活的子代理（等长流式响应）不再被误杀，真挂死的照常收敛（对标 zcode runner.ts:1191）。
 */
export const SUBAGENT_INACTIVITY_MS = 120_000;
/** 完成通知防伪头（定义在 agent-messaging.ts，此处转出口保持既有导入路径） */
export { SUBAGENT_NOTIFICATION_HEADER };

const EXPLORE_TOOLS = new Set(["read", "glob", "grep", "extract", "web_fetch", "web_search", "sessions"]);

const TaskArgs = z.object({
  subagent_type: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  /** sync（默认，阻塞等结论）| background（立即返回，完成后经命令队列通知注入） */
  wait: z.enum(["sync", "background"]).optional(),
});

export interface TaskToolDeps {
  llmFactory: (model: string) => Promise<LLMProvider>;
  /** 父会话当前模型（setModel 后随之更新） */
  currentModel: () => string;
  cwd: string;
  kcodeHomeDir: string;
  /** 父会话已装配的工具全集（不含 task 本身——子代理不嵌套派生） */
  baseTools: Tool[];
  /** 父会话 hooks（pre_tool_use 守卫对子代理同样生效） */
  hooks: HookRunner;
  /** 权限引擎工厂：explore 只读档 / 其他默认档（ask 经父 asker 转达用户） */
  permissionFor: (kind: "readonly" | "default") => PermissionEngine;
  asker?: PermissionAsker;
  agents: AgentLibrary;
  /** 运行环境块（OS/shell 方言） */
  envBlock: string;
  onNotice?: (message: string) => void;
  /* ---- N3D-1 异步子代理接线（全部可选，缺省保持纯同步行为）---- */
  /** 父会话 id（spawned/stopped 事件与通知的归属） */
  parentSessionId?: string;
  /** 后台任务注册表：子代理注册进去，task_output/task_stop/任务面板直接复用 */
  registry?: BackgroundTaskRegistry;
  /** 父会话 sink：subagent_spawned/stopped 事件落父时间线（回放/审计可见） */
  parentSink?: SessionSink;
  /** ask_user 透传：子代理遇到真分叉可问用户（替代"按最合理假设执行"） */
  askUser?: UserPromptPort;
  /** 完成通知注入（父忙=入队 / 父空闲=直接开新 turn）；实现方负责防伪头之外的队列语义 */
  notify?: (text: string) => void;
  /** 后台子代理登记（Esc 连杀）：注册 kill 回调，返回反注册函数 */
  trackBackground?: (kill: () => void) => () => void;
  /** 子代理句柄注册表（N3D-2）：SendMessage 寻址（loop 引用/终态 LRU） */
  agentRegistry?: SubagentRegistry;
}

const SUBAGENT_BASE_PROMPT = `你是 kcode 的子代理，在隔离上下文中执行委派任务。
- 委派方能看到你的最终结论：在轮次内完成任务，产出自包含的结论（引用 file:line，不堆砌整文件）
- 需要用户决策时可用 ask_user 提问（经父会话转达）；不便提问时按最合理假设执行并在结论中注明
- 中间发现/部分结论可用 respond_to_coordinator 异步转达协调者（不阻塞、不等回复）
- 委派任务即全部背景，与本会话无关的猜测不要写入结论`;

interface AgentConfig {
  name: string;
  tools: Tool[];
  permissionKind: "readonly" | "default";
  model?: string;
  body: string;
}

/** 子代理运行结果（sync 回灌 / background 通知共用） */
interface SubRunResult {
  status: "completed" | "failed" | "stopped";
  turns: number;
  toolCalls: number;
  usage: { input: number; output: number };
  conclusion: string;
  hitLimit: boolean;
  error?: string;
}

/**
 * task 工具（B1；N3D-1 升级双模）：
 * wait=sync（默认）阻塞等结论回灌 tool_result；wait=background 立即返回 subId，
 * 完成后经命令队列注入父上下文（notify），task_output/task_stop 直接可查可停。
 * 子会话全量落盘 sessions/subagents/sub_<id>.jsonl（不污染用户会话清单）。
 */
export function buildTaskTool(deps: TaskToolDeps): Tool {
  const resolveAgent = (type: string): AgentConfig | { error: string } => {
    if (type === "general-purpose") {
      return {
        name: type,
        tools: deps.baseTools,
        permissionKind: "default",
        body: "通用子代理：按委派指令使用可用工具完成任务并给出结论。",
      };
    }
    if (type === "explore") {
      return {
        name: type,
        tools: deps.baseTools.filter((t) => EXPLORE_TOOLS.has(t.definition.name)),
        permissionKind: "readonly",
        body: "只读搜索子代理：广度优先探索代码库，返回结论与关键 file:line 引用；不修改任何文件。",
      };
    }
    const found = deps.agents.get(type);
    if (found === undefined) {
      return { error: `未知子代理类型「${type}」（可用：general-purpose、explore 或 .kcode/agents 定义的名称）` };
    }
    const names = new Set(found.manifest.tools);
    return {
      name: found.manifest.name,
      tools:
        names.size === 0
          ? deps.baseTools
          : deps.baseTools.filter((t) => names.has(t.definition.name)),
      permissionKind: "default",
      model: found.manifest.model,
      body: found.body,
    };
  };

  return {
    definition: {
      name: "task",
      description:
        "派生子代理执行委派任务（隔离上下文）——适合大范围代码搜索、多文件调研、或需多步骤独立完成的子任务。wait=sync（默认）阻塞等最终结论；wait=background 立即返回任务号并在完成后自动通知（长任务用后台，配合 task_output 查进度/task_stop 终止）",
      parameters: {
        type: "object",
        properties: {
          subagent_type: {
            type: "string",
            description: "子代理类型：general-purpose（通用）| explore（只读搜索）| .kcode/agents 定义的名称",
          },
          description: { type: "string", description: "任务一句话概述（进度展示用）" },
          prompt: { type: "string", description: "完整任务指令：目标、范围、预期返回格式" },
          wait: { type: "string", enum: ["sync", "background"], description: "sync（默认）阻塞等结论；background 后台运行完成即通知" },
        },
        required: ["subagent_type", "description", "prompt"],
      },
      readOnly: false,
      // N3D-1：子代理派生本身批内并发安全（并发组模型 + fan-out 的前提）；无墙钟（看门狗在内部）
      concurrentSafe: true,
      permission: { default: "allow" },
    },
    async execute(input, ctx): Promise<ToolOutput> {
      const parsed = TaskArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const { subagent_type: type, description, prompt, wait } = parsed.data;
      const background = wait === "background";
      const config = resolveAgent(type);
      if ("error" in config) {
        return { ok: false, output: "", error: config.error };
      }
      if (config.tools.length === 0) {
        return { ok: false, output: "", error: `子代理 ${type} 的工具集为空（检查 tools 定义与父会话可用工具的交集）` };
      }
      const model = config.model ?? deps.currentModel();
      let llm: LLMProvider;
      try {
        llm = await deps.llmFactory(model);
      } catch (err) {
        return { ok: false, output: "", error: `子代理模型构建失败: ${err instanceof Error ? err.message : String(err)}` };
      }
      const subId = newId("sub");

      // 子会话双写：内存留结论提取用，磁盘落 sessions/subagents/（回放/审计/二期复活基础）
      const subDir = join(deps.kcodeHomeDir, "cli", "sessions", "subagents");
      await mkdir(subDir, { recursive: true }).catch(() => undefined);
      const memory = new MemorySink();
      const disk = await JsonlSessionSink.open(join(subDir, `${subId}.jsonl`)).catch(() => null);
      if (disk === null) {
        deps.onNotice?.(`子代理 ${subId} 会话落盘失败（目录不可写），本子代理仅内存态`);
      }

      // 不活动看门狗：任何子事件活动都重置；子代理自身的中断通道（sync 链到父 signal，background 独立）
      const childAbort = new AbortController();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const armWatchdog = (): void => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => childAbort.abort(), SUBAGENT_INACTIVITY_MS);
      };
      const sink: SessionSink = {
        append: async (event) => {
          armWatchdog();
          await memory.append(event);
          if (disk !== null) {
            await disk.append(event).catch(() => undefined);
          }
        },
      };
      const unregisterKill = background ? deps.trackBackground?.(() => childAbort.abort()) : undefined;

      // default 档子代理补 ask_user（经父端口转达）；explore 只读档用不到；
      // respond_to_coordinator 无条件注入（对标 zcode subagent.ts:541——子代理回父的唯一通道）
      const respondTool =
        deps.notify !== undefined
          ? buildRespondToCoordinatorTool({ childId: subId, childType: type, notify: deps.notify })
          : undefined;
      const childTools = [
        ...config.tools,
        ...(config.permissionKind === "default" && deps.askUser !== undefined
          ? [createAskUserTool({ prompt: deps.askUser })]
          : []),
        ...(respondTool !== undefined ? [respondTool] : []),
      ];

      const loop = new AgentLoop(
        {
          llm,
          tools: new InMemoryToolRegistry(childTools),
          permissions: deps.permissionFor(config.permissionKind),
          hooks: deps.hooks,
          sink,
          audit: new MemoryAudit().sink,
          // ask 经父 asker 转达用户（项目级持久放行同样生效）；explore 只读档不会触发 ask
          asker: config.permissionKind === "default" ? deps.asker : undefined,
        },
        {
          sessionId: subId,
          model,
          systemPrompt: `${SUBAGENT_BASE_PROMPT}

${deps.envBlock}

【子代理角色】${config.body}`,
          cwd: deps.cwd,
          maxTurns: SUBAGENT_MAX_TURNS,
        },
      );

      const emit = (event: Parameters<SessionSink["append"]>[0]): void => {
        // 事件落父时间线失败不阻断子代理（best-effort；子会话自有独立落盘）
        void Promise.resolve(deps.parentSink?.append(event)).catch(() => undefined);
      };
      emit({
        v: 1,
        type: "subagent_spawned",
        ts: Date.now(),
        sessionId: deps.parentSessionId ?? "",
        agentId: subId,
        agentType: type,
        description,
        childSessionId: subId,
        background,
      });
      deps.registry?.track({
        id: subId,
        command: `[${type}] ${description}`,
        status: "running",
        logPath: join(subDir, `${subId}.jsonl`),
        startedAt: Date.now(),
      });
      // 句柄双注册（N3D-2）：SendMessage 经 agentRegistry 寻址本子代理（steer/续跑）
      deps.agentRegistry?.register({
        id: subId,
        agentType: type,
        description,
        loop,
        status: "running",
        kill: () => childAbort.abort(),
      });
      deps.onNotice?.(`子代理 ${type} 开始：${description}${background ? "（后台）" : ""}`);

      /** 跑完并从内存事件提取结论与用量（sync 回灌 / background 通知共用） */
      const runChild = async (): Promise<SubRunResult> => {
        let summary: { turns: number; toolCalls: number };
        try {
          // sync 链父 signal（用户中断父即中断子）；background 用 childAbort（Esc 连杀/看门狗）
          summary = await loop.run(prompt, {
            signal: background ? childAbort.signal : AbortSignal.any([childAbort.signal, ...(ctx.signal !== undefined ? [ctx.signal] : [])]),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // 中断既可能走返回值也可能走抛错路径（工具 abort 常见后者）——两条路都归一为 stopped
          if (childAbort.signal.aborted || ctx.signal?.aborted === true) {
            return { status: "stopped", turns: 0, toolCalls: 0, usage: { input: 0, output: 0 }, conclusion: "", hitLimit: false };
          }
          return { status: "failed", turns: 0, toolCalls: 0, usage: { input: 0, output: 0 }, conclusion: "", hitLimit: false, error: message };
        }
        const events = memory.events;
        const lastAssistant = [...events].reverse().find((e) => e.type === "assistant_message" && e.content !== "") as
          | { content: string }
          | undefined;
        const usage = events
          .filter((e) => e.type === "session_end")
          .reduce(
            (acc, e) => {
              const u = (e as { usage?: { inputTokens: number; outputTokens: number } }).usage;
              return u === undefined ? acc : { input: acc.input + u.inputTokens, output: acc.output + u.outputTokens };
            },
            { input: 0, output: 0 },
          );
        const hitLimit = events.some((e) => e.type === "run_limit_reached");
        const llmError = events.find((e) => e.type === "llm_error") as { error: string } | undefined;
        const aborted = childAbort.signal.aborted || ctx.signal?.aborted === true;
        if (aborted) {
          return { status: "stopped", turns: summary.turns, toolCalls: summary.toolCalls, usage, conclusion: "", hitLimit };
        }
        if (lastAssistant === undefined) {
          return {
            status: "failed",
            turns: summary.turns,
            toolCalls: summary.toolCalls,
            usage,
            conclusion: "",
            hitLimit,
            error: llmError?.error ?? "未产出结论",
          };
        }
        return { status: "completed", turns: summary.turns, toolCalls: summary.toolCalls, usage, conclusion: lastAssistant.content, hitLimit };
      };

      /** 终态收口：注册表翻转、stopped 事件、看门狗与连杀登记清理 */
      const finalize = (r: SubRunResult): SubRunResult => {
        clearTimeout(watchdog);
        unregisterKill?.();
        deps.registry?.update(subId, {
          status: r.status === "completed" ? "done" : "failed",
          exitCode: r.status === "completed" ? 0 : 1,
        });
        deps.agentRegistry?.markTerminal(subId);
        emit({
          v: 1,
          type: "subagent_stopped",
          ts: Date.now(),
          sessionId: deps.parentSessionId ?? "",
          agentId: subId,
          agentType: type,
          description,
          status: r.status,
          turns: r.turns,
          toolCalls: r.toolCalls,
          usage: { inputTokens: r.usage.input, outputTokens: r.usage.output },
        });
        return r;
      };

      const metaLine = (r: SubRunResult): string =>
        `子代理 ${type}：${r.turns} 轮 · ${r.toolCalls} 次工具调用${r.usage.input > 0 || r.usage.output > 0 ? ` · ${r.usage.input}+${r.usage.output} tok` : ""}${r.hitLimit ? " · ⚠ 达到轮次上限，结论可能不完整" : ""}`;

      if (background) {
        // 立即回执；完成经 notify 注入（task_output 终态读取已认领则不重复通知——幂等）
        void runChild().then((r) => {
          finalize(r);
          const claimed = deps.registry?.get(subId)?.notified === true;
          deps.registry?.update(subId, { notified: true });
          if (!claimed && deps.notify !== undefined) {
            const head = `${SUBAGENT_NOTIFICATION_HEADER}\n后台子代理${
              r.status === "completed" ? "完成" : r.status === "stopped" ? "被中断" : "失败"
            }：${type}「${description}」（${subId}，${metaLine(r)}）`;
            deps.notify(
              r.status === "completed"
                ? `${head}\n结论：\n${r.conclusion}`
                : `${head}\n原因：${r.error ?? "（无详细信息）"}`,
            );
          }
        });
        return {
          ok: true,
          output: `后台子代理已启动 ${subId}（${type}：${description}）——完成后自动通知；task_output {taskId:"${subId}"} 查进度，task_stop 可终止`,
        };
      }

      const r = finalize(await runChild());
      deps.registry?.update(subId, { notified: true }); // tool_result 已送达即认领
      if (r.status === "failed") {
        return { ok: false, output: "", error: `子代理执行失败: ${r.error ?? "未知错误"}` };
      }
      if (r.status === "stopped") {
        return { ok: false, output: "", error: "子代理被用户中断" };
      }
      return { ok: true, output: `${r.conclusion}\n\n（${metaLine(r)}）` };
    },
  };
}
