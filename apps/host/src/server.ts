import { homedir } from "node:os";
import { join } from "node:path";
import { newId } from "@kcode/shared";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type HostFrame,
  type SessionCreateParams,
  type SessionSubmitParams,
} from "@kcode/contracts";
import { listSessions } from "@kcode/runtime";
import { HostSession } from "./session.js";
import { createCliPlatformService } from "./platform.js";

/**
 * 宿主服务（N3-1 注 A/D）：持有最多一个会话（每会话一进程），排空权威在本进程。
 * 方法路由 + commandId 幂等（同 id 重复请求返缓存结果，防网络重试双执行）。
 */
export class HostServer {
  readonly hostId = newId("host");
  #session: HostSession | null = null;
  #responses = new Map<string, { ok: true; result?: unknown } | { ok: false; error: string }>();
  readonly kcodeHomeDir: string;
  #platformCache: ReturnType<typeof createCliPlatformService> | null = null;

  constructor(private readonly send: (frame: HostFrame) => void) {
    this.kcodeHomeDir = process.env["KCODE_HOME"] ?? join(homedir(), ".kcode");
  }

  /** 宿主侧平台服务（完整 IPlatformService——key 不出宿主，N3-2 注 E） */
  #platform(): ReturnType<typeof createCliPlatformService> {
    if (this.#platformCache === null) {
      this.#platformCache = createCliPlatformService(this.kcodeHomeDir);
    }
    return this.#platformCache;
  }

  async handleFrame(frame: import("@kcode/contracts").ClientFrame): Promise<void> {
    if (frame.kind === "hello") {
      if (frame.hello.major !== PROTOCOL_MAJOR) {
        this.send({ kind: "res", id: "__hello__", ok: false, error: `协议主版本不一致：本端 v${PROTOCOL_MAJOR}，远端 v${frame.hello.major}` });
        process.exit(1);
      }
      this.send({
        kind: "hello",
        hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: ["session", "queue", "ask"] },
      });
      this.send({ kind: "ev", event: { type: "ready", hostId: this.hostId, pid: process.pid } });
      return;
    }
    const { id, method } = frame;
    // commandId 幂等
    const cached = this.#responses.get(id);
    if (cached !== undefined) {
      this.send(cached.ok ? { kind: "res", id, ok: true, ...(cached.result !== undefined ? { result: cached.result } : {}) } : { kind: "res", id, ok: false, error: cached.error });
      return;
    }
    const result = await this.#dispatch(method, frame.params).then(
      (r): { ok: true; result?: unknown } | { ok: false; error: string } => ({ ok: true, ...(r !== undefined ? { result: r } : {}) }),
      (err): { ok: false; error: string } => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    this.#responses.set(id, result);
    this.send(result.ok ? { kind: "res", id, ok: true, ...(result.result !== undefined ? { result: result.result } : {}) } : { kind: "res", id, ok: false, error: result.error });
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/create": {
        if (this.#session !== null) {
          throw new Error("本宿主已持有会话（每会话一进程，注 D）");
        }
        const p = params as SessionCreateParams;
        this.#session = new HostSession(this.hostId, this.kcodeHomeDir, this.send);
        return this.#session.create(p);
      }
      case "session/submit": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.submit(params as SessionSubmitParams);
      }
      case "session/interrupt": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.interrupt();
      }
      case "session/set_mode": {
        if (this.#session === null) throw new Error("会话未创建");
        this.#session.setMode((params as { mode: import("@kcode/contracts").PermissionMode }).mode);
        return;
      }
      case "session/set_model": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.setModel((params as { ref: string }).ref);
      }
      case "ask/respond": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.askRespond(params as { requestId: string; allowed: boolean; scope?: "once" | "session" | "project" });
      }
      case "question/respond": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.questionRespond(params as { requestId: string; labels: string[] });
      }
      case "platform/probe": {
        // N3-2 注 E：key 是否已录入——在宿主侧查（key 明文不出宿主）
        const ref = (params as { ref: string }).ref;
        const platform = this.#platform();
        try {
          const entry = await platform.openDefaultKeychain().get(ref);
          return { available: entry !== null };
        } catch {
          return { available: false };
        }
      }
      case "platform/save_key": {
        // N3-2 注 E：key 录入——宿主侧选择口令/系统存储并写入（前端只投递参数）
        const p = params as import("@kcode/contracts").PlatformSaveKeyParams;
        const platform = this.#platform();
        if (p.passphrase !== undefined && p.passphrase !== "") {
          await platform.openPassphraseKeychain(p.passphrase).set(p.ref, p.key, p.audiences);
        } else {
          await platform.openSecureKeychain().set(p.ref, p.key, p.audiences);
        }
        return;
      }
      case "sessions/list": {
        const summaries = await listSessions(join(this.kcodeHomeDir, "cli", "sessions"));
        return { sessions: summaries.slice(0, 20).map((s) => ({ sessionId: s.sessionId, preview: s.preview, turns: s.turns })) };
      }
      default:
        throw new Error(`未知方法 ${method}`);
    }
  }

  /** 断连/退出：fail-closed 结算全部未决交互 */
  async shutdown(reason: string): Promise<void> {
    this.send({ kind: "ev", event: { type: "host/closing", reason } });
    await this.#session?.shutdown();
  }
}
