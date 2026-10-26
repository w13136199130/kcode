import { describe, expect, it } from "vitest";
import { sessionsSignature } from "../src/renderer/lib/sessions-signature.js";
import type { SessionSummary } from "../src/renderer/components/desktop-sidebar-model.js";

function row(overrides: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return { preview: "", turns: 1, ...overrides };
}

describe("会话列表签名（P1-2 / M5）", () => {
  it("内容一致 → 签名一致；单字段变化 → 签名变化", () => {
    const a = [row({ sessionId: "s1", modifiedAt: 1, title: "t", preview: "p", workspaceKey: "E:/ws" })];
    const b = [row({ sessionId: "s1", modifiedAt: 1, title: "t", preview: "p", workspaceKey: "E:/ws" })];
    expect(sessionsSignature(a)).toBe(sessionsSignature(b));

    expect(sessionsSignature([row({ sessionId: "s1", modifiedAt: 2 })])).not.toBe(
      sessionsSignature([row({ sessionId: "s1", modifiedAt: 1 })]),
    );
    for (const changed of [
      { title: "新标题" },
      { preview: "新预览" },
      { workspaceKey: "E:/other" },
      { draft: true },
      { archived: true },
      { deleted: true },
      { turns: 3 },
    ]) {
      expect(sessionsSignature([row({ sessionId: "s1", ...changed })])).not.toBe(
        sessionsSignature([row({ sessionId: "s1" })]),
      );
    }
  });

  it("条目增删/顺序变化 → 签名变化", () => {
    const one = [row({ sessionId: "s1" })];
    const two = [row({ sessionId: "s1" }), row({ sessionId: "s2" })];
    expect(sessionsSignature(one)).not.toBe(sessionsSignature(two));
    expect(sessionsSignature(two)).not.toBe(sessionsSignature([...two].reverse()));
  });

  it("空列表签名为确定值（与 null 初始态区分，避免首次空结果被跳过）", () => {
    expect(sessionsSignature([])).toBe("");
  });
});
