import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFrame } from "@kcode/contracts";
import { startHttpListener, type HttpListener, type HttpListenerServer } from "../src/http-listen.js";
import { HostServer } from "../src/server.js";

/** S2-4：HTTP 第二通道（同 dispatch 底座；127.0.0.1 + Bearer token + SSE）。 */
describe("http listener（S2-4）", () => {
  let listener: HttpListener;
  const calls: Array<{ method: string; params?: unknown }> = [];

  beforeAll(async () => {
    const fake: HttpListenerServer = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "boom") throw new Error("注入失败");
        return { echo: method };
      },
    };
    listener = await startHttpListener({ server: fake, token: "t-test" });
  });
  afterAll(async () => {
    await listener.close();
  });

  const base = (): string => `http://127.0.0.1:${listener.port}`;

  it("health 无需鉴权；rpc 未带 token 401", async () => {
    const health = await fetch(`${base()}/health`);
    expect(health.status).toBe(200);
    const denied = await fetch(`${base()}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "sessions/list" }),
    });
    expect(denied.status).toBe(401);
  });

  it("Bearer token 驱动同一 dispatch；业务错误走 ok:false（HTTP 200）", async () => {
    const ok = await fetch(`${base()}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t-test" },
      body: JSON.stringify({ method: "sessions/list", params: { limit: 5 } }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, result: { echo: "sessions/list" } });
    expect(calls.at(-1)).toEqual({ method: "sessions/list", params: { limit: 5 } });

    const fail = await fetch(`${base()}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t-test" },
      body: JSON.stringify({ method: "boom" }),
    });
    expect(fail.status).toBe(200);
    expect(await fail.json()).toEqual({ ok: false, error: "注入失败" });
  });

  it("SSE 事件流：?token= 鉴权，broadcast 帧可达", async () => {
    const controller = new AbortController();
    const stream = await fetch(`${base()}/events?token=t-test`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    // 先吞掉 ":ok\n\n" 注释行，再等 broadcast 帧
    listener.broadcast({ kind: "ev", event: { type: "notice", message: "hello-sse" } } as HostFrame);
    let text = "";
    for (let i = 0; i < 10 && !text.includes("hello-sse"); i += 1) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value ?? new Uint8Array());
    }
    controller.abort();
    expect(text).toContain("hello-sse");
    expect(text).toContain(`"type":"notice"`);
  });
});

/** 真实 HostServer 经 request() 走 sessions/list（验证 HTTP 底座接的是真 dispatch）。 */
describe("http listener × 真实 HostServer（S2-4）", () => {
  let home: string;
  let server: HostServer;
  let listener: HttpListener;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "kcode-http-"));
    process.env["KCODE_HOME"] = join(home, ".kcode");
    server = new HostServer(() => undefined);
    await server.start();
    listener = await startHttpListener({ server, token: "t-real" });
  });
  afterAll(async () => {
    await listener.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  });

  it("HTTP rpc 返回真实 sessions/list 结果", async () => {
    const res = await fetch(`http://127.0.0.1:${listener.port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t-real" },
      body: JSON.stringify({ method: "sessions/list" }),
    });
    const body = (await res.json()) as { ok: boolean; result?: { sessions?: unknown[]; total?: number } };
    expect(body.ok).toBe(true);
    expect(body.result?.sessions).toEqual([]);
    expect(body.result?.total).toBe(0);
  });
});
