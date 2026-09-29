import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionEvent } from "@kcode/contracts";
import { createSessionsTool } from "../src/session/sessions-tool.js";

/**
 * sessions 工具 read 动作（ReadSessionContext 语义）：summary 浓缩与 full 全文回读
 * 两种模式的边界——full 从最近往前装填、超预算截断并标注省略条数。
 */

let dir: string;

function event(partial: { type: SessionEvent["type"] } & Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ts: 0, sessionId: "sess_fix", ...partial })}\n`;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kcode-sessions-read-"));
  await writeFile(
    join(dir, "sess_alpha.jsonl"),
    [
      event({ type: "session_start", cwd: "proj/x" }),
      event({ type: "user_message", content: "第一轮的很长的问题".repeat(20) }),
      event({ type: "assistant_message", content: "第一轮回答的很长内容".repeat(20) }),
      event({ type: "user_message", content: "最后的提问：总结一下" }),
      event({ type: "assistant_message", content: "最后的回答全文。" }),
      event({ type: "session_end", reason: "completed" }),
    ].join(""),
    "utf8",
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sessions read（summary / full）", () => {
  const tool = () => createSessionsTool({ sessionsDir: dir });

  it("summary：默认浓缩转写，每条只取首行", async () => {
    const r = await tool().execute({ action: "read", sessionId: "sess_alpha" }, { sessionId: "s", cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("浓缩转写");
    expect(r.output).toContain("最后的提问：总结一下");
    // 浓缩模式截到 120 字符：不应包含第一轮的完整重复文本
    expect(r.output).not.toContain("第一轮的很长的问题".repeat(14));
  });

  it("full：全文回读从最近往前装填，超预算截断并标注省略", async () => {
    const r = await tool().execute({ action: "read", sessionId: "sess_alpha", detail: "full" }, { sessionId: "s", cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("全文回读");
    // 末端完整内容必须在（续接场景要的是最新状态）
    expect(r.output).toContain("最后的回答全文。");
    expect(r.output).toContain("最后的提问：总结一下");
    // 两条早期长消息（约 480 字符）超出 8000 预算的情况不会发生——这里断言省略标注只在真超预算时出现
    expect(r.output).not.toContain("因长度省略");
  });

  it("full 真超预算：早期消息被省略并标注条数", async () => {
    // 构造超长会话：末端短消息 + 早期巨量内容
    await writeFile(
      join(dir, "sess_big.jsonl"),
      [
        event({ type: "session_start", cwd: "proj/x" }),
        event({ type: "user_message", content: "很早的巨量内容。".repeat(3000) }),
        event({ type: "user_message", content: "末端短提问" }),
        event({ type: "session_end", reason: "completed" }),
      ].join(""),
      "utf8",
    );
    const r = await tool().execute({ action: "read", sessionId: "sess_big", detail: "full" }, { sessionId: "s", cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("末端短提问");
    expect(r.output.match(/前 \d+ 条较早消息因长度省略/)).not.toBeNull();
  });

  it("read 缺 sessionId / 会话不存在仍按既有语义报错", async () => {
    const missing = await tool().execute({ action: "read" }, { sessionId: "s", cwd: dir });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("sessionId");
    const none = await tool().execute({ action: "read", sessionId: "sess_none" }, { sessionId: "s", cwd: dir });
    expect(none.ok).toBe(false);
    expect(none.error).toContain("不存在");
  });
});
