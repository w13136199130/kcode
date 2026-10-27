import { describe, expect, it } from "vitest";
import type { HostEvent } from "@kcode/contracts";
import { applyEvent, initialTimeline } from "../src/renderer/components/projection.js";
import { isQuotaError, quotaFeedbackText, quotaResetUrl } from "../src/renderer/lib/quota.js";

const ev = (event: Record<string, unknown>): HostEvent =>
  ({ type: "session/event", event }) as HostEvent;

describe("P4-2 额度错误识别（isQuotaError）", () => {
  it.each([
    ['{"error":{"code":"1112","message":"余额不足，请充值"}}', true],
    ["You exceeded your current quota, please check your plan and billing details", true],
    ["Insufficient balance for account", true],
    ["insufficient_quota: this key has run out of credits", true],
    ["billing_hard_error: credit balance too low", true],
    ["HTTP 402 Payment Required", true],
    ["额度已用尽，请联系管理员充值", true],
    ["上下文可能超限；可 /compact 后重试", false],
    ["HTTP 404 Not Found", false],
    ["429 Too Many Requests: rate limit exceeded, retry later", false],
    ["connect ECONNREFUSED 127.0.0.1:8080", false],
  ])("%s -> %s", (message, expected) => {
    expect(isQuotaError(message)).toBe(expected);
  });

  it("重置额度 URL：已知厂商映射、未知厂商回落 null", () => {
    expect(quotaResetUrl("bigmodel/GLM-5.3")).toBe("https://open.bigmodel.cn/finance/overview");
    expect(quotaResetUrl("GLM/glm-5.3")).toContain("open.bigmodel.cn");
    expect(quotaResetUrl("openai/gpt-4o")).toContain("platform.openai.com");
    expect(quotaResetUrl("mock/model")).toBeNull();
    expect(quotaResetUrl("")).toBeNull();
  });

  it("反馈文本包含错误/模型/会话", () => {
    const text = quotaFeedbackText({ error: "1112 余额不足", model: "mock/model", sessionId: "s1" });
    expect(text).toContain("1112 余额不足");
    expect(text).toContain("mock/model");
    expect(text).toContain("s1");
  });
});

describe("P4-2 运行态投影（quota/paused/todos/agents）", () => {
  it("额度类 llm_error 渲染为 quota 行，普通错误仍为 info 行", () => {
    let state = initialTimeline();
    state = applyEvent(state, ev({ v: 1, type: "llm_error", ts: 1, sessionId: "s", error: "1112 余额不足" }));
    state = applyEvent(state, ev({ v: 1, type: "llm_error", ts: 2, sessionId: "s", error: "HTTP 404" }));
    expect(state.rows.at(-2)).toEqual({ kind: "quota", text: "1112 余额不足" });
    expect(state.rows.at(-1)).toEqual({ kind: "info", text: "✗ 模型调用失败：HTTP 404", tone: "warn" });
  });

  it("todo_update 更新 todos 状态（进度卡数据源），行内保留历史", () => {
    let state = initialTimeline();
    state = applyEvent(
      state,
      ev({
        v: 1,
        type: "todo_update",
        ts: 1,
        sessionId: "s",
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
        ],
      }),
    );
    expect(state.todos).toHaveLength(2);
    expect(state.rows.at(-1)?.kind).toBe("todo");
  });

  it("subagent spawn/stopped 归并为子智能体卡（缺 spawn 的 stop 也补卡）", () => {
    let state = initialTimeline();
    state = applyEvent(
      state,
      ev({ v: 1, type: "subagent_spawned", ts: 1, sessionId: "s", agentId: "ag1", agentType: "Explore", description: "搜索文档", childSessionId: "sub_1", background: false }),
    );
    expect(state.agents).toEqual([{ agentId: "ag1", agentType: "Explore", description: "搜索文档", status: "running" }]);
    state = applyEvent(
      state,
      ev({ v: 1, type: "subagent_stopped", ts: 2, sessionId: "s", agentId: "ag1", agentType: "Explore", description: "搜索文档", status: "completed", turns: 3, toolCalls: 5, usage: { inputTokens: 1, outputTokens: 2 } }),
    );
    expect(state.agents).toEqual([{ agentId: "ag1", agentType: "Explore", description: "搜索文档", status: "completed", turns: 3 }]);
    state = applyEvent(
      state,
      ev({ v: 1, type: "subagent_stopped", ts: 3, sessionId: "s", agentId: "ag2", agentType: "Plan", description: "补卡", status: "stopped", turns: 0, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 } }),
    );
    expect(state.agents.at(-1)?.agentId).toBe("ag2");
    expect(state.agents.at(-1)?.status).toBe("stopped");
  });

  it("暂停点：run_limit 置位 → session_end(limit_reached) 保持 → 用户输入清除", () => {
    let state = initialTimeline();
    state = applyEvent(state, ev({ v: 1, type: "run_limit_reached", ts: 1, sessionId: "s", maxTurns: 24 }));
    expect(state.paused).toEqual({ reason: "limit", maxTurns: 24 });
    state = applyEvent(state, ev({ v: 1, type: "session_end", ts: 2, sessionId: "s", reason: "limit_reached" }));
    expect(state.paused).toEqual({ reason: "limit", maxTurns: 24 });
    expect(state.busy).toBe(false);
    state = applyEvent(state, ev({ v: 1, type: "user_message", ts: 3, sessionId: "s", content: "继续" }));
    expect(state.paused).toBeNull();
  });

  it("预算暂停：session_end(rejected + 预算文案) 置位；普通 rejected 不置位", () => {
    let state = initialTimeline();
    state = applyEvent(state, ev({ v: 1, type: "session_end", ts: 1, sessionId: "s", reason: "rejected", detail: "会话 token 预算已用尽（100/100）——可调整" }));
    expect(state.paused?.reason).toBe("budget");
    expect(state.paused?.detail).toContain("预算");
    state = applyEvent(state, ev({ v: 1, type: "user_message", ts: 2, sessionId: "s", content: "继续" }));
    state = applyEvent(state, ev({ v: 1, type: "session_end", ts: 3, sessionId: "s", reason: "rejected", detail: "hook 否决" }));
    expect(state.paused).toBeNull();
  });

  it("session_end(completed) 清除暂停点", () => {
    let state = initialTimeline();
    state = applyEvent(state, ev({ v: 1, type: "run_limit_reached", ts: 1, sessionId: "s", maxTurns: 24 }));
    expect(state.paused).not.toBeNull();
    state = applyEvent(state, ev({ v: 1, type: "session_end", ts: 3, sessionId: "s", reason: "completed", usage: { inputTokens: 1, outputTokens: 1, calls: 1 } }));
    expect(state.paused).toBeNull();
  });
});
