import { app } from "electron";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR, type HostEvent, type HostFrame, type ClientFrame } from "@kcode/contracts";
import { spawnHost } from "./host.js";

/**
 * M1 自动化验收（无窗口）：main 直接 fork host + 持有 MessagePortMain 走完整协议——
 * hello → ready → session/create → session/submit（真实模型一问）→ 期待 delta 与 session_end。
 * 退出码即验收结果（CI 可用）；另验证 attach 二次挂载（reload 语义的最小面）。
 */

interface SmokeDeps {
  frames: HostFrame[];
  request(method: string, params?: unknown): Promise<unknown>;
  /** 等待某类事件到达（submit 应答回执只代表入队，事件流是异步的——首轮实测教训） */
  waitForEvent(type: string, timeoutMs: number): Promise<HostEvent>;
}

async function protocolOverPort(): Promise<{ deps: SmokeDeps; done: () => void }> {
  const exited = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("smoke 超时：host 未在 90s 内完成对话")), 90_000);
  });
  const host = spawnHost((code) => {
    process.stdout.write(`[smoke] host 退出（code=${code}）\n`);
  });
  const port = host.attachPort();
  const frames: HostFrame[] = [];
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventWaiters = new Set<{ type: string; resolve: (e: HostEvent) => void; timer: NodeJS.Timeout }>();
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const waitForEvent = (type: string, timeoutMs: number): Promise<HostEvent> =>
    new Promise((resolve, reject) => {
      const matches = (ev: HostEvent): boolean =>
        // 顶层类型（delta/notice…）或 session/event 信封内的循环事件（session_end/llm_error…）
        ev.type === type ||
        (ev.type === "session/event" && (ev as { event?: { type?: string } }).event?.type === type);
      // 已到的帧里先找一遍
      const existing = frames.find(
        (f): f is Extract<HostFrame, { kind: "ev" }> => f.kind === "ev" && matches(f.event as HostEvent),
      );
      if (existing !== undefined) {
        resolve(existing.event as HostEvent);
        return;
      }
      const waiter = {
        type,
        resolve,
        timer: setTimeout(() => {
          eventWaiters.delete(waiter);
          reject(new Error(`smoke：${timeoutMs}ms 内未等到事件 ${type}`));
        }, timeoutMs),
      };
      eventWaiters.add(waiter);
    });

  port.on("message", (ev) => {
    const frame = JSON.parse(String(ev.data)) as HostFrame;
    frames.push(frame);
    if (frame.kind === "hello") return;
    if (frame.kind === "ev") {
      const event = frame.event as HostEvent;
      if (event.type === "ready") resolveReady?.();
      for (const waiter of [...eventWaiters]) {
        const inner = (event as { event?: { type?: string } }).event;
        if (waiter.type === event.type || (event.type === "session/event" && inner?.type === waiter.type)) {
          eventWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(event);
        }
      }
      return;
    }
    if (frame.kind === "res") {
      const p = pending.get(frame.id);
      if (p !== undefined) {
        pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new Error(frame.error));
      }
    }
  });
  port.start();

  const send = (frame: ClientFrame): void => {
    port.postMessage(JSON.stringify(frame));
  };
  send({ kind: "hello", hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: [] } });
  // 握手快败：10s 无 ready 直接报错（曾因外置依赖 require .ts 静默挂死——快败优于挂起）
  await Promise.race([
    ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("smoke：host 10s 未完成握手（ready 未到达）")), 10_000),
    ),
  ]);

  let counter = 0;
  const request = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = `smoke-${++counter}`;
      pending.set(id, { resolve, reject });
      send({ kind: "req", id, method, ...(params !== undefined ? { params } : {}) });
    });

  return {
    deps: { frames, request, waitForEvent },
    done: () => void host.dispose(),
  };
}

async function defaultModelRef(): Promise<string> {
  const env = process.env["KCODE_SMOKE_MODEL"];
  if (env !== undefined && env !== "") return env;
  const cfg = JSON.parse(await readFile(join(homedir(), ".kcode", "config.json"), "utf8")) as {
    models?: { default?: string };
  };
  const ref = cfg.models?.default;
  if (ref === undefined || ref === "") {
    throw new Error("未找到默认模型（~/.kcode/config.json models.default 或 KCODE_SMOKE_MODEL）");
  }
  return ref;
}

export async function runSmoke(): Promise<boolean> {
  const { deps, done } = await protocolOverPort();
  try {
    const model = await defaultModelRef();
    const created = (await deps.request("session/create", { model, cwd: process.cwd() })) as {
      sessionId?: string;
    };
    if (created.sessionId === undefined || created.sessionId === "") {
      throw new Error("session/create 未返回 sessionId");
    }
    process.stdout.write(`[smoke] 会话 ${created.sessionId.slice(0, 16)}… 已创建\n`);

    await deps.request("session/submit", { text: "只回复两个字符：ok" });

    const wrapped = await deps.waitForEvent("session_end", 60_000);
    const end = ((wrapped as { event?: { reason?: string } }).event ?? wrapped) as { reason?: string };
    const hasDelta = deps.frames.some(
      (f) => f.kind === "ev" && (f.event as HostEvent).type === "delta",
    );
    const ok = hasDelta && end.reason === "completed";
    process.stdout.write(
      `[smoke] 对话完成：delta=${hasDelta} session_end=${end.reason ?? "无"} → ${ok ? "✓ 通过" : "✗ 失败"}\n`,
    );
    return ok;
  } finally {
    done();
  }
}

// 未使用断言辅助（app 引入仅为确保 electron 运行时就绪语义明确）
void app;
