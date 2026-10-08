import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ScriptedLLM } from "@kcode/core";
import type { IPlatformService } from "@kcode/contracts";
import type { KeychainStore } from "@kcode/platform";
import type { ProviderRouter } from "@kcode/platform";
import type { Runtime } from "../src/bootstrap.js";
import { runHeadless, DeltaWriter } from "../src/headless.js";

/**
 * headless（N3C-1）集成测试：真实 composeSession + ScriptedLLM，不渲染 Ink。
 * 断言 stdout 的 NDJSON 可解析、末行 result 记录、退出码语义。
 */

let home: string;
let workspace: string;
let savedCwd: string;

const keychain: KeychainStore = {
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async list() {
    return [];
  },
};

function fakeRuntime(llm: ScriptedLLM): Runtime {
  return {
    models: { providers: {}, default: "scripted/simple" },
    keychain,
    router: { resolve: async () => llm } as unknown as ProviderRouter,
    platform: {} as IPlatformService,
    kcodeHomeDir: home,
  } as unknown as Runtime;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-headless-"));
  workspace = await mkdtemp(join(tmpdir(), "kcode-headless-ws-"));
  savedCwd = process.cwd();
});

afterAll(async () => {
  process.chdir(savedCwd);
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("runHeadless", () => {
  it("--json：每行可 JSON.parse，含会话事件与末行 result；成功退出码 0", async () => {
    process.chdir(workspace);
    const lines: string[] = [];
    const code = await runHeadless(
      fakeRuntime(new ScriptedLLM([{ text: "你好" }])),
      "scripted/simple",
      { prompt: "打个招呼", json: true },
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; status?: string });
    // 会话生命周期事件在流里，末行是 CLI 级 result 记录
    expect(parsed[0]?.type).toBe("session_start");
    expect(parsed.some((e) => e.type === "assistant_message")).toBe(true);
    const last = parsed.at(-1);
    expect(last?.type).toBe("result");
    expect(last?.status).toBe("completed");
  }, 30_000);

  it("非 json（N3F-7）：正文流式写出、末尾换行、不重复摘要行", async () => {
    process.chdir(workspace);
    const lines: string[] = [];
    const code = await runHeadless(
      fakeRuntime(new ScriptedLLM([{ text: "好的，这是结论。" }])),
      "scripted/simple",
      { prompt: "再做一次", json: false },
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    const joined = lines.join("");
    expect(joined).toContain("好的，这是结论。");
    expect(joined.endsWith("\n")).toBe(true);
    // 流式模式不重复摘要（状态经退出码传达）
    expect(joined).not.toMatch(/✓ completed/);
  }, 30_000);

  it("--disallowed-tools 透传：剔除 write 后组装期不报未知（可正常跑完）", async () => {
    process.chdir(workspace);
    const lines: string[] = [];
    const code = await runHeadless(
      fakeRuntime(new ScriptedLLM([{ text: "完成" }])),
      "scripted/simple",
      { prompt: "干活", json: true, disallowedTools: ["write", "edit"] },
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines.at(-1) as string).status).toBe("completed");
  }, 30_000);
});

describe("N3F-7 DeltaWriter 微缓冲", () => {
  it("64 字节阈值即时冲刷；50ms 定时冲刷；空串直通忽略", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const w = new DeltaWriter((s) => writes.push(s));
    w.push("");
    w.push("abc"); // < 64B：缓冲并起定时器
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(49);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual(["abc"]);
    w.push("x".repeat(64)); // 阈值即时冲刷
    expect(writes).toEqual(["abc", "x".repeat(64)]);
    vi.useRealTimers();
  });

  it("endNewline：末字符非换行补一个；已是换行不补", () => {
    const writes: string[] = [];
    const w = new DeltaWriter((s) => writes.push(s));
    w.endNewline(); // 未流式：不动
    expect(writes).toEqual([]);
    w.push("tail");
    w.flush();
    w.endNewline();
    expect(writes).toEqual(["tail", "\n"]);
    w.push("end\n");
    w.flush();
    w.endNewline();
    expect(writes).toEqual(["tail", "\n", "end\n"]);
  });
});
