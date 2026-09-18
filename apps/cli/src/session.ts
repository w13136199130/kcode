import { join } from "node:path";
import type {
  LLMProvider,
  PermissionAsker,
  SessionEvent,
  SessionSink,
  UserPromptPort,
} from "@kcode/contracts";
import { AgentLoop, InMemoryToolRegistry, MemoryAudit, noHooks } from "@kcode/core";
import {
  DEFAULT_RULES,
  READONLY_RULES,
  MutablePermissionEngine,
  RuleBasedPermissionEngine,
} from "@kcode/extensions";
import { JsonlSessionSink } from "@kcode/runtime";
import { newId } from "@kcode/shared";
import { createSessionTools } from "@kcode/tools";
import { kcodeHome } from "./bootstrap.js";

export const SYSTEM_PROMPT = `你是 kcode（快码），本地优先的代码助手。
- 回答代码问题前先用工具查证（read/glob/grep），结论引用 file:line；
- 不知道就说不知道，不臆造文件与符号；
- 多步骤任务用 todo 工具维护任务清单；需要用户决策时用 ask_user 提选择题；
- 回答简洁，中文。`;

export const PLAN_MODE_SUFFIX = `

【计划模式】只读研究：可用读工具调研，不得修改文件或执行有副作用的命令；
产出一份明确的执行计划并等待用户确认，用户用 /plan off 切回执行模式。`;

export interface SessionHandle {
  loop: AgentLoop;
  sessionId: string;
  /** 会话 JSONL（ADR-7：append-only，回放/eval 复用） */
  jsonlPath: string;
  /** 计划模式切换（§1.1 A 域）：readonly 权限 + 计划 system prompt */
  setPlanMode(on: boolean): void;
}

/**
 * 建会话：AgentLoop + 会话工具全集（读放行，写/bash 经 ask 确认——§7 默认预设），
 * 事件双写——onEvent 实时渲染、JSONL 落盘 ~/.kcode/cli/sessions/；
 * onDelta 流式增量、onNotice 后台任务通知（瞬态，不落盘）。
 */
export async function createSession(opts: {
  llm: LLMProvider;
  model: string;
  cwd: string;
  onEvent?: (event: SessionEvent) => void;
  onDelta?: (delta: string) => void;
  onNotice?: (message: string) => void;
  asker?: PermissionAsker;
  askUser?: UserPromptPort;
}): Promise<SessionHandle> {
  const sessionId = newId("sess");
  const jsonlPath = join(kcodeHome(), "cli", "sessions", `${sessionId}.jsonl`);
  const disk = await JsonlSessionSink.open(jsonlPath);
  const sink: SessionSink = {
    append: async (event) => {
      opts.onEvent?.(event);
      await disk.append(event);
    },
  };
  const permissions = new MutablePermissionEngine(
    new RuleBasedPermissionEngine({ rules: DEFAULT_RULES, fallback: "deny" }),
  );
  const loop = new AgentLoop(
    {
      llm: opts.llm,
      tools: new InMemoryToolRegistry(
        createSessionTools({
          sessionId,
          artifactsDir: join(kcodeHome(), "cli", "artifacts", sessionId),
          onNotice: opts.onNotice,
          sink,
          prompt: opts.askUser,
        }),
      ),
      permissions,
      hooks: noHooks,
      sink,
      audit: new MemoryAudit().sink,
      asker: opts.asker,
      onDelta: opts.onDelta,
    },
    {
      sessionId,
      model: opts.model,
      systemPrompt: SYSTEM_PROMPT,
      cwd: opts.cwd,
      maxTurns: 24,
    },
  );
  const setPlanMode = (on: boolean): void => {
    permissions.set(
      new RuleBasedPermissionEngine({
        rules: on ? READONLY_RULES : DEFAULT_RULES,
        fallback: "deny",
      }),
    );
    loop.updateSystemPrompt(SYSTEM_PROMPT + (on ? PLAN_MODE_SUFFIX : ""));
  };
  return { loop, sessionId, jsonlPath, setPlanMode };
}
