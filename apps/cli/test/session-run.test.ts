import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/daemon-client.js";
import { createSession } from "../src/session.js";

function fakeClient() {
  let done!: Parameters<DaemonClient["onRunDone"]>[0];
  const request = vi.fn(async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.method === "session_create") return { kind: "session_ok", sessionId: "s1", resumedMessages: 0 };
    if (payload.method === "commands_list") return { kind: "commands", commands: [] };
    return { kind: "accepted" };
  });
  const client = {
    request, onEvent: vi.fn(), onDelta: vi.fn(), onNotice: vi.fn(), onClose: vi.fn(),
    onRunDone: (callback: typeof done) => { done = callback; },
  } as unknown as DaemonClient;
  return { client, request, finish: (...args: Parameters<typeof done>) => done(...args) };
}

describe("远程会话运行通知", () => {
  it("run_done 早于 accepted 到达仍能完成，下一轮可以继续", async () => {
    const fake = fakeClient();
    const session = await createSession({ client: fake.client, cwd: ".", model: "test" });
    fake.request.mockImplementation(async (payload) => {
      fake.finish("s1", 0, 0, payload.runId as string, "rejected");
      return { kind: "accepted" };
    });
    await expect(session.loop.run("blocked")).resolves.toMatchObject({ status: "rejected" });
    await expect(session.loop.run("again")).resolves.toMatchObject({ status: "rejected" });
  });

  it("忽略旧 run 通知，拒绝重入，取消携带当前 runId", async () => {
    const fake = fakeClient();
    const session = await createSession({ client: fake.client, cwd: ".", model: "test" });
    const running = session.loop.run("go");
    const request = fake.request.mock.calls.find(([p]) => p.method === "session_send")![0];
    fake.finish("s1", 10, 10, "old-run", "completed");
    await expect(session.loop.run("overlap")).rejects.toThrow("正在运行");
    session.abort();
    expect(fake.request).toHaveBeenCalledWith({ method: "session_abort", sessionId: "s1", runId: request.runId });
    fake.finish("s1", 1, 0, request.runId as string, "aborted");
    await expect(running).resolves.toMatchObject({ status: "aborted", turns: 1 });
  });

  it("请求失败后释放互斥，可重新发送", async () => {
    const fake = fakeClient();
    const session = await createSession({ client: fake.client, cwd: ".", model: "test" });
    fake.request.mockRejectedValueOnce(new Error("offline"));
    await expect(session.loop.run("first")).rejects.toThrow("offline");
    const running = session.loop.run("retry");
    const payload = fake.request.mock.calls.at(-1)![0];
    fake.finish("s1", 1, 0, payload.runId as string, "completed");
    await expect(running).resolves.toMatchObject({ status: "completed" });
  });
});
