import { z } from "zod";
import type {
  HookRunner,
  LLMProvider,
  PermissionAsker,
  PermissionEngine,
  SessionSink,
  Tool,
  ToolOutput,
} from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit, MemorySink } from "@kcode/core";
import { AgentLibrary } from "@kcode/extensions";
import { newId } from "@kcode/shared";

/** 子代理轮次上限（成本护栏；到顶仍返回已有结论并标注不完整） */
export const SUBAGENT_MAX_TURNS = 12;

/** explore 子代理的只读工具集（与 READONLY_RULES 放行面对齐） */
const EXPLORE_TOOLS = new Set(["read", "glob", "grep", "extract", "web_fetch", "web_search", "sessions"]);

const TaskArgs = z.object({
  subagent_type: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
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
}

const SUBAGENT_BASE_PROMPT = `你是 kcode 的子代理，在隔离上下文中执行委派任务。
- 委派方只能看到你的最终结论：在轮次内完成任务，产出自包含的结论（引用 file:line，不堆砌整文件）
- 你无法与用户直接交互；需要决策时按最合理假设执行并在结论中注明
- 委派任务即全部背景，与本会话无关的猜测不要写入结论`;

interface AgentConfig {
  name: string;
  tools: Tool[];
  permissionKind: "readonly" | "default";
  model?: string;
  body: string;
}

/** task 工具（B1）：派生隔离上下文的子代理，同步阻塞，最终结论作为 tool_result 回灌父会话 */
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
        "派生子代理执行委派任务（隔离上下文，只把最终结论带回本会话）——适合大范围代码搜索、多文件调研、或需多步骤独立完成的子任务",
      parameters: {
        type: "object",
        properties: {
          subagent_type: {
            type: "string",
            description: "子代理类型：general-purpose（通用）| explore（只读搜索）| .kcode/agents 定义的名称",
          },
          description: { type: "string", description: "任务一句话概述（进度展示用）" },
          prompt: { type: "string", description: "完整任务指令：目标、范围、预期返回格式" },
        },
        required: ["subagent_type", "description", "prompt"],
      },
      readOnly: false,
    },
    async execute(input, ctx): Promise<ToolOutput> {
      const parsed = TaskArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const { subagent_type: type, description, prompt } = parsed.data;
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
      const sink: SessionSink = new MemorySink();
      const loop = new AgentLoop(
        {
          llm,
          tools: new InMemoryToolRegistry(config.tools),
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
      deps.onNotice?.(`子代理 ${type} 开始：${description}`);
      let summary: { turns: number; toolCalls: number };
      try {
        summary = await loop.run(prompt, { signal: ctx.signal });
      } catch (err) {
        return {
          ok: false,
          output: "",
          error: `子代理执行失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (ctx.signal?.aborted) {
        return { ok: false, output: "", error: "子代理被用户中断" };
      }
      const events = (sink as MemorySink).events;
      const conclusion = [...events]
        .reverse()
        .find((e) => e.type === "assistant_message" && e.content !== "") as
        | { content: string }
        | undefined;
      const hitLimit = events.some((e) => e.type === "run_limit_reached");
      const llmErrors = events.filter((e) => e.type === "llm_error") as { error: string }[];
      const usage = events
        .filter((e) => e.type === "session_end")
        .reduce(
          (acc, e) => {
            const u = (e as { usage?: { inputTokens: number; outputTokens: number } }).usage;
            return u === undefined ? acc : { input: acc.input + u.inputTokens, output: acc.output + u.outputTokens };
          },
          { input: 0, output: 0 },
        );
      if (conclusion === undefined) {
        return {
          ok: false,
          output: "",
          error: `子代理未产出结论${llmErrors.length > 0 ? `（${llmErrors[0]!.error}）` : ""}`,
        };
      }
      const meta: string[] = [`子代理 ${type}：${summary.turns} 轮 · ${summary.toolCalls} 次工具调用`];
      if (usage.input > 0 || usage.output > 0) {
        meta.push(`${usage.input}+${usage.output} tok`);
      }
      if (hitLimit) {
        meta.push("⚠ 达到轮次上限，结论可能不完整");
      }
      return { ok: true, output: `${conclusion.content}\n\n（${meta.join(" · ")}）` };
    },
  };
}
