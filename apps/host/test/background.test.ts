import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostFrame } from "@kcode/contracts";
import { BackgroundManager } from "../src/background.js";

/**
 * S3-3 后台会话管理器（真实子 host，无 LLM——模型指向不可达端点，
 * 提交后子会话走到 llm_error/session_end 终态，验证的是孵化/转发/停止机制）。
 */
const HOST_BIN = resolve(import.meta.dirname, "../src/main.ts");
const cliReq = createRequire(resolve(import.meta.dirname, "../../cli/package.json"));
const tsxUrl = pathToFileURL(cliReq.resolve("tsx")).href;

let homeDir: string;
let workDir: string;

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kcode-bg-test-"));
  workDir = await mkdtemp(join(tmpdir(), "kcode-bg-cwd-"));
  await mkdir(join(homeDir, "cli", "sessions"), { recursive: true });
  await writeFile(
    join(homeDir, "config.json"),
    JSON.stringify({
      models: { default: "test/echo", providers: { test: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1" } } },
    }),
  );
});

afterAll(async () => {
  await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

function manager(events: HostFrame[]): BackgroundManager {
  return new BackgroundManager(
    (frame) => events.push(frame),
    { command: process.execPath, args: ["--import", tsxUrl, HOST_BIN], env: { ...process.env, KCODE_HOME: homeDir } },
  );
}

describe("BackgroundManager（S3-3）", () => {
  it("start：孵化子 host → 建会话 → 提交；事件转发带 sessionId；list 可见", async () => {
    const events: HostFrame[] = [];
    const mgr = manager(events);
    const { sessionId } = await mgr.start({ model: "test/echo", cwd: workDir, prompt: "后台任务一" });
    expect(sessionId).not.toBe("");
    // 子会话事件（user_message 先于 LLM 失败；端点不可达 → llm_error → session_end）
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      const poll = setInterval(() => {
        if (events.some((f) => f.kind === "ev" && f.event.type === "session/event")) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 100);
    });
    const relayed = events.filter((f) => f.kind === "ev" && f.event.type === "session/event");
    expect(relayed.length).toBeGreaterThan(0);
    const listed = mgr.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sessionId).toBe(sessionId);
    expect(listed[0]?.preview).toContain("后台任务一");
    // 等到终态：busy 归位（llm_error → session_end failed）
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      const poll = setInterval(() => {
        if (mgr.list()[0]?.busy === false) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 150);
    });
    expect(mgr.list()[0]?.busy).toBe(false);
    await mgr.stop(sessionId);
    expect(mgr.list()).toHaveLength(0);
  }, 60_000);

  it("参数校验：缺 prompt/缺 model 明确报错，不孵化进程", async () => {
    const mgr = manager([]);
    await expect(mgr.start({ model: "test/echo", cwd: workDir, prompt: "  " })).rejects.toThrow("prompt");
    await expect(mgr.start({ cwd: workDir, prompt: "x" })).rejects.toThrow("model");
    expect(mgr.list()).toHaveLength(0);
  });

  it("stop 未知会话返回 stopped:false；disposeAll 幂等", async () => {
    const mgr = manager([]);
    await expect(mgr.stop("ghost")).resolves.toEqual({ stopped: false });
    await mgr.disposeAll();
  });
});
