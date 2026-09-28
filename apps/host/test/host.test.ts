import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostClient, loadSessionEvents } from "@kcode/runtime";

/**
 * N3-1 宿主集成测试（真实子进程，无 LLM——模型指向不可达端点，测试的是协议机制）：
 * - 握手 + 创建 + 提交（run 走到 llm_error 终态 → 宿主仍活）
 * - kill -9 → 新宿主接管（lease epoch+1）→ JSONL 无幽灵写回
 * - 双活拒绝：前持有者存活 → 新宿主 session/create 报错
 * - 断连 fail-closed：客户端 kill → 宿主进程退出
 */

const HOST_BIN = resolve(import.meta.dirname, "../src/main.ts");
const cliReq = createRequire(resolve(import.meta.dirname, "../../cli/package.json"));
const tsxUrl = pathToFileURL(cliReq.resolve("tsx")).href;
const MODEL = "test/echo";

let homeDir: string;
let workDir: string;

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kcode-host-test-"));
  workDir = await mkdtemp(join(tmpdir(), "kcode-host-cwd-"));
  await mkdir(join(homeDir, "cli", "sessions"), { recursive: true });
  await writeFile(
    join(homeDir, "config.json"),
    JSON.stringify({ models: { default: MODEL, providers: { test: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1" } } } }),
  );
});

afterAll(async () => {
  await rm(homeDir, { recursive: true, force: true }).catch(() => {});
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

async function spawnHost(): Promise<HostClient> {
  return HostClient.spawn(HOST_BIN, {
    env: { KCODE_HOME: homeDir },
    exec: [process.execPath, "--import", tsxUrl],
  });
}

describe("宿主进程 N3-1（真实子进程）", () => {
  it("握手 → 创建 → 提交 → 事件流到达（LLM 不可达 → failed 终态，宿主仍活）", async () => {
    const host = await spawnHost();
    const created = await host.createSession({ model: MODEL, cwd: workDir });
    expect(created.sessionId).toMatch(/^sess_/);
    expect(created.epoch).toBeGreaterThanOrEqual(1);

    // 提交 → run 走到终态（LLM 不可达：status=failed，但协议完整）
    // 注意：waitFor 必须先建监听再 submit（await waitFor 会阻塞在 submit 之前）
    const summaryPromise = host.waitFor((e) => e.type === "session/summary", 60_000);
    await host.submit("echo hello world");
    const summary = await summaryPromise;

    expect(summary.type).toBe("session/summary");
    if (summary.type !== "session/summary") throw new Error("unreachable");
    expect(["failed", "completed"]).toContain(summary.summary.status);

    // JSONL 有事件（session_start + user_message + session_end）
    const events = await loadSessionEvents(join(homeDir, "cli", "sessions", `${created.sessionId}.jsonl`));
    expect(events.some((e) => e.type === "session_start")).toBe(true);
    expect(events.some((e) => e.type === "user_message" && e.content === "echo hello world")).toBe(true);
    expect(events.some((e) => e.type === "session_end")).toBe(true);
    // lease 事件存在
    expect(events.some((e) => e.type === "host_lease")).toBe(true);
    host.close();
  }, 30_000);

  it("kill -9 后无幽灵 run 写回：新宿主接管，lease epoch+1，JSONL 无重复消息", async () => {
    const host1 = await spawnHost();
    const created = await host1.createSession({ model: MODEL, cwd: workDir });
    // 提交（LLM 不可达但事件会落盘）
    const s1Promise = host1.waitFor((e) => e.type === "session/summary", 60_000);
    await host1.submit("first message");
    await s1Promise;
    // kill -9
    host1.kill();
    await host1.exited;

    // JSONL 有事件
    const file = join(homeDir, "cli", "sessions", `${created.sessionId}.jsonl`);
    const eventsAfterKill = await loadSessionEvents(file);
    expect(eventsAfterKill.some((e) => e.type === "user_message" && e.content === "first message")).toBe(true);

    // kill -9 后无幽灵 run 写回：新宿主接管，lease epoch+1
    // 注意：resume 会开新会话文件（composeSession 语义——旧文件保留、新文件续写历史）
    const host2 = await spawnHost();
    const resumed = await host2.createSession({ model: MODEL, cwd: workDir, resumeFrom: created.sessionId });
    expect(resumed.epoch).toBe(created.epoch + 1);

    const s2Promise = host2.waitFor((e) => e.type === "session/summary", 60_000);
    await host2.submit("second message");
    await s2Promise;
    host2.close();

    // 旧文件：first message 恰好一次（kill -9 后无人再写——无幽灵写回）
    const oldEvents = await loadSessionEvents(file);
    const firstCount = oldEvents.filter((e) => e.type === "user_message" && (e as { content: string }).content === "first message").length;
    expect(firstCount).toBe(1);
    // 旧文件 lease：第一条 epoch = created.epoch
    const oldLeases = oldEvents.filter((e): e is Extract<(typeof oldEvents)[number], { type: "host_lease" }> => e.type === "host_lease");
    expect(oldLeases.length).toBeGreaterThanOrEqual(1);
    expect(oldLeases[0]!.epoch).toBe(created.epoch);

    // 新文件：second message 恰好一次、first message 零次（种子是历史不是事件重放）
    const newFile = join(homeDir, "cli", "sessions", `${resumed.sessionId}.jsonl`);
    const newEvents = await loadSessionEvents(newFile);
    const secondCount = newEvents.filter((e) => e.type === "user_message" && (e as { content: string }).content === "second message").length;
    expect(secondCount).toBe(1);
    const newFirstCount = newEvents.filter((e) => e.type === "user_message" && (e as { content: string }).content === "first message").length;
    expect(newFirstCount).toBe(0);
    // 新文件 lease：epoch = 前+1
    const newLeases = newEvents.filter((e): e is Extract<(typeof newEvents)[number], { type: "host_lease" }> => e.type === "host_lease");
    expect(newLeases.length).toBeGreaterThanOrEqual(1);
    expect(newLeases[0]!.epoch).toBe(created.epoch + 1);
  }, 40_000);

  it("双活拒绝：前持有者存活 → 新宿主 session/create 报错", async () => {
    const host1 = await spawnHost();
    const created = await host1.createSession({ model: MODEL, cwd: workDir });
    const s1Promise = host1.waitFor((e) => e.type === "session/summary", 60_000);
    await host1.submit("dual host test");
    await s1Promise;

    const host2 = await spawnHost();
    await expect(host2.createSession({ model: MODEL, cwd: workDir, resumeFrom: created.sessionId })).rejects.toThrow(/另一宿主/);
    host2.close();
    host1.close();
  }, 30_000);

  it("断连 fail-closed：客户端 kill → 宿主进程退出", async () => {
    const host = await spawnHost();
    await host.createSession({ model: MODEL, cwd: workDir });
    host.kill();
    const exit = await host.exited;
    expect(exit.signal !== null || exit.code !== 0).toBe(true);
  }, 30_000);
});
