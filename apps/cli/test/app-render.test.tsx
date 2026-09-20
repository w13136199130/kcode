import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { DaemonClient } from "../src/daemon-client.js";

// 会话层全 mock：App 渲染行为不依赖守护进程
vi.mock("../src/session.js", () => ({
  createSession: vi.fn(async () => ({
    sessionId: "sess_render",
    loop: { run: async () => ({ sessionId: "sess_render", turns: 0, toolCalls: 0 }) },
    setMode: () => {},
    setModel: async () => null,
    models: async () => ({ providers: [] }),
    listSkills: async () => [],
    skillBody: async () => null,
    listSessions: async () => [],
    listCommands: () => [],
    expandCommand: async () => null,
    trustProject: async () => {},
  })),
}));

import { KcodeApp } from "../src/tui/App.js";

const fakeClient = {} as DaemonClient;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("KcodeApp 渲染（空闲不重绘）", () => {
  it("空闲状态下帧数稳定——250ms 时钟只在 busy/流式/运行中工具时激活", async () => {
    const instance = render(
      <KcodeApp client={fakeClient} model="mock/1" cwd="E:/tmp" />,
    );
    // 等待 mount + ready 两帧落定
    await sleep(400);
    const settled = instance.frames.length;
    // 空闲 800ms（超过 3 个时钟周期）：不应有任何新帧
    await sleep(800);
    expect(instance.frames.length).toBe(settled);
    expect(instance.lastFrame()).toContain("kcode");
    instance.unmount();
  }, 10_000);
});
