import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Runtime } from "../src/bootstrap.js";

// 会话层全 mock：App 渲染行为不依赖会话实现
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
    isProjectTrusted: async () => false,
    usage: async () => null,
    context: async () => null,
  })),
}));

import { KcodeApp } from "../src/tui/App.js";
import { createSession } from "../src/session.js";

const fakeRuntime = {
  models: { default: "mock/1", providers: {} },
  keychain: { async get() { return null; }, async set() {}, async delete() {}, async list() { return []; } },
  router: {},
  platform: { secureStorageAvailable: false, async probe() { return false; }, async saveKey() {} },
  kcodeHomeDir: "E:/tmp/.kcode-test",
} as unknown as Runtime;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("KcodeApp 渲染（空闲不重绘）", () => {
  it("空闲状态下帧数稳定——250ms 时钟只在 busy/流式/运行中工具时激活", async () => {
    const instance = render(
      <KcodeApp runtime={fakeRuntime} model="mock/1" cwd="E:/tmp" />,
    );
    // 等待 mount + ready + 命令菜单 600ms 补读定时器全部落定
    await sleep(900);
    const settled = instance.frames.length;
    // 空闲 800ms（超过 3 个时钟周期）：不应有任何新帧
    await sleep(800);
    expect(instance.frames.length).toBe(settled);
    expect(instance.lastFrame()).toContain("kcode");
    instance.unmount();
  }, 10_000);

  it("2-05 fatal 驻留：显示错误与修复提示，不自动退出", async () => {
    vi.mocked(createSession).mockRejectedValueOnce(new Error("缺少 KCODE_KEYCHAIN_PASSPHRASE"));
    const instance = render(
      <KcodeApp runtime={fakeRuntime} model="mock/1" cwd="E:/tmp" />,
    );
    await sleep(150);
    expect(instance.lastFrame()).toContain("✗");
    expect(instance.lastFrame()).toContain("按 r 重试");
    // 80ms 后原来会自动退出；现在必须在屏上等用户
    await sleep(300);
    expect(instance.lastFrame()).toContain("按 r 重试");
    instance.unmount();
  }, 10_000);
});
