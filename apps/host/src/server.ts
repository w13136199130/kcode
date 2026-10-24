import { homedir } from "node:os";
import { join } from "node:path";
import { newId, workspaceKey } from "@kcode/shared";
import {
  ConfigSaveParams,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  ProviderConfig,
  type HostFrame,
  type PlanRespondParams,
  type SessionCreateParams,
  type SessionSubmitParams,
} from "@kcode/contracts";
import { createProviderRouter, openKeychain } from "@kcode/platform";
import { deleteSession, listSessions, renameSession } from "@kcode/runtime";import { isProjectTrusted, trustProject } from "@kcode/session";
import { HostSession } from "./session.js";
import { createCliPlatformService } from "./platform.js";
import { loadUserModelsConfig } from "./boot.js";
import { saveUserProvider } from "./config.js";
import { addWorkspace, listWorkspaces, removeWorkspace } from "./workspace-store.js";
import { listArchived, setArchived } from "./task-state.js";
import { listSessionIndex, patchSessionIndex, reconcileSessionIndex, removeSessionIndex, upsertSessionIndex } from "./session-index.js";
import { clearDeletedSessions, listDeletedSessions, setSessionDeleted } from "./session-trash.js";

function workspacePathParam(params: unknown): string {
  const path = (params as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || path.trim() === "") throw new Error("工作区路径不能为空");
  return path.trim();
}

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

  /** 启动时把 JSONL 摘要回填索引；不阻塞 hello，失败只影响索引新鲜度。 */
  async reconcile(): Promise<void> {
    const summaries = await listSessions(join(this.kcodeHomeDir, "cli", "sessions")).catch(() => []);
    await reconcileSessionIndex(this.kcodeHomeDir, summaries).catch(() => undefined);
  }

  #sessionsChanged(reason: string): void {
    this.send({ kind: "ev", event: { type: "sessions/changed", reason } });
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
        hello: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, capabilities: ["session", "queue", "ask", "plan", "config"] },
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
      case "workspace/list": {
        const workspaces = await listWorkspaces(this.kcodeHomeDir);
        return {
          workspaces: workspaces.map((workspace) => ({
            ...workspace,
            trusted: isProjectTrusted(workspace.path, this.kcodeHomeDir),
          })),
        };
      }
      case "workspace/add": {
        const workspace = await addWorkspace(this.kcodeHomeDir, workspacePathParam(params));
        return {
          workspace: {
            ...workspace,
            trusted: isProjectTrusted(workspace.path, this.kcodeHomeDir),
          },
        };
      }
      case "workspace/remove": {
        return { removed: await removeWorkspace(this.kcodeHomeDir, workspacePathParam(params)) };
      }
      case "workspace/trust": {
        const path = workspacePathParam(params);
        await trustProject(path, this.kcodeHomeDir);
        return { path, trusted: true };
      }
      case "workspace/status": {
        const path = workspacePathParam(params);
        return { path, trusted: isProjectTrusted(path, this.kcodeHomeDir) };
      }
      case "session/create": {
        const p = params as SessionCreateParams;
        // 幂等（M1 实测修订）：reload/StrictMode 重挂后 renderer 会重复 create——
        // 每会话一进程（注 D）语义下宿主会话不重建，直接返回既有会话（对话上下文在宿主侧未丢）
        if (this.#session !== null) {
          return this.#session.describe();
        }
        this.#session = new HostSession(this.hostId, this.kcodeHomeDir, this.send);
        const created = await this.#session.create(p);
        // 先落索引再返回：即使首条消息前崩溃/重启，空会话也不会从侧栏消失。
        await upsertSessionIndex(this.kcodeHomeDir, {
          sessionId: created.sessionId,
          workspaceKey: workspaceKey(p.cwd),
        }).catch(() => undefined);
        this.#sessionsChanged("create");
        return created;
      }
      case "session/dispose": {
        // 同窗口切会话：释放旧会话（host 进程保持活——新建/续接接续而来）
        if (this.#session !== null) {
          await this.#session.dispose();
          this.#session = null;
        }
        return { disposed: true };
      }
      case "session/replay": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.replay();
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
      case "session/commands": {
        if (this.#session === null) return { commands: [] };
        return { commands: this.#session.listCommands() };
      }
      case "session/command": {
        if (this.#session === null) throw new Error("会话未创建");
        const p = params as { name: string; args?: string };
        const text = await this.#session.expandCommand(p.name, p.args ?? "");
        if (text === null) throw new Error(`未知命令 /${p.name}`);
        return { text };
      }
      case "session/compact": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.compact();
      }
      case "session/files": {
        if (this.#session === null) return { files: [] };
        return { files: await this.#session.searchFiles((params as { query?: string } | undefined)?.query ?? "") };
      }
      case "session/tasks": {
        if (this.#session === null) throw new Error("会话未创建");
        return { tasks: this.#session.listTasks() };
      }
      case "session/task_stop": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.stopTask((params as { id: string }).id);
      }
      case "session/changes": {
        if (this.#session === null) throw new Error("会话未创建");
        return { changes: await this.#session.listChanges() };
      }
      case "session/revert": {
        if (this.#session === null) throw new Error("会话未创建");
        const paths = (params as { paths?: string[] } | undefined)?.paths;
        return this.#session.revertChanges(paths);
      }
      case "ask/respond": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.askRespond(params as { requestId: string; allowed: boolean; scope?: "once" | "session" | "project" });
      }
      case "question/respond": {
        if (this.#session === null) throw new Error("会话未创建");
        return this.#session.questionRespond(params as { requestId: string; labels: string[] });
      }
      case "plan/respond": {
        if (this.#session === null) throw new Error("会话未创建");
        this.#session.planRespond(params as PlanRespondParams);
        return;
      }
      case "config/get": {
        const models = await loadUserModelsConfig(this.kcodeHomeDir);
        return {
          defaultModel: models.default ?? null,
          providers: Object.entries(models.providers).map(([name, provider]) => ({
            name,
            type: provider.type,
            ...("baseURL" in provider ? { baseURL: provider.baseURL } : {}),
            ...("keyRef" in provider && provider.keyRef !== undefined ? { keyRef: provider.keyRef } : {}),
          })),
        };
      }
      case "config/save": {
        const p = ConfigSaveParams.parse(params);
        const provider = ProviderConfig.safeParse(p.provider);
        if (!provider.success) throw new Error(`provider 配置不合法：${provider.error.message.slice(0, 200)}`);
        if (p.key !== undefined) {
          const platform = this.#platform();
          if (p.key.passphrase !== undefined && p.key.passphrase !== "") {
            await platform.openPassphraseKeychain(p.key.passphrase).set(p.key.ref, p.key.key, p.key.audiences);
          } else {
            await platform.openSecureKeychain().set(p.key.ref, p.key.key, p.key.audiences);
          }
        }
        await saveUserProvider(this.kcodeHomeDir, {
          providerName: p.providerName,
          provider: provider.data,
          model: p.model,
        });
        return { model: p.model };
      }
      case "models/list": {
        const models = await loadUserModelsConfig(this.kcodeHomeDir);
        const keychain = openKeychain(join(this.kcodeHomeDir, "keys.json"));
        const router = createProviderRouter(models, keychain);
        const modelRef = (params as { model?: string } | undefined)?.model ?? models.default;
        if (modelRef === undefined || modelRef === "") throw new Error("未指定模型，且配置没有 models.default");
        const provider = await router.resolve(modelRef);
        return { models: (await provider.listModels?.()) ?? [] };
      }
      case "provider/probe": {
        const models = await loadUserModelsConfig(this.kcodeHomeDir);
        const keychain = openKeychain(join(this.kcodeHomeDir, "keys.json"));
        const router = createProviderRouter(models, keychain);
        const modelRef = (params as { model?: string } | undefined)?.model ?? models.default;
        if (modelRef === undefined || modelRef === "") throw new Error("未指定模型，且配置没有 models.default");
        await router.resolve(modelRef);
        return { ok: true };
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
        await reconcileSessionIndex(this.kcodeHomeDir, summaries).catch(() => undefined);
        const indexed = await listSessionIndex(this.kcodeHomeDir);
        const deleted = await listDeletedSessions(this.kcodeHomeDir);
        const byId = new Map(summaries.map((s) => [s.sessionId, s]));
        const merged = summaries.map((s) => {
          const meta = indexed.find((item) => item.sessionId === s.sessionId);
          return {
            sessionId: s.sessionId,
            preview: s.preview,
            turns: s.turns,
            modifiedAt: s.modifiedAt,
            workspaceKey: s.workspaceKey !== "" ? s.workspaceKey : (meta?.workspaceKey ?? ""),
            ...(s.title !== undefined ? { title: s.title } : {}),
          };
        });
        for (const meta of indexed) {
          if (byId.has(meta.sessionId)) continue;
          merged.push({
            sessionId: meta.sessionId,
            preview: meta.preview ?? "",
            turns: meta.preview !== undefined && meta.preview !== "" ? 1 : 0,
            modifiedAt: meta.updatedAt,
            workspaceKey: meta.workspaceKey,
            ...(meta.title !== undefined ? { title: meta.title } : {}),
          });
        }
        const archived = await listArchived(this.kcodeHomeDir);
        return {
          sessions: merged
            .sort((a, b) => b.modifiedAt - a.modifiedAt)
            .slice(0, 100)
            .map((s) => ({
              ...s,
              ...(archived.has(s.sessionId) ? { archived: true } : {}),
              ...(deleted.has(s.sessionId) ? { deleted: true } : {}),
            })),
        };
      }
      case "sessions/rename": {
        const p = params as { sessionId: string; title: string };
        await renameSession(join(this.kcodeHomeDir, "cli", "sessions"), p.sessionId, p.title);
        await patchSessionIndex(this.kcodeHomeDir, p.sessionId, { title: p.title }).catch(() => undefined);
        this.#sessionsChanged("rename");
        return;
      }
      case "sessions/delete": {
        const p = params as { sessionId: string };
        if (this.#session?.describe().sessionId === p.sessionId) {
          throw new Error("不能删除正在使用的会话（先新建或切换到其他会话）");
        }
        await setSessionDeleted(this.kcodeHomeDir, p.sessionId, true);
        await setArchived(this.kcodeHomeDir, p.sessionId, false);
        this.#sessionsChanged("delete");
        return;
      }
      case "sessions/restore": {
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== "string" || p.sessionId.trim() === "") {
          throw new Error("sessionId 不能为空");
        }
        await setSessionDeleted(this.kcodeHomeDir, p.sessionId, false);
        this.#sessionsChanged("restore");
        return { sessionId: p.sessionId, deleted: false };
      }
      case "sessions/purge": {
        const p = params as { sessionId?: unknown };
        if (typeof p.sessionId !== "string" || p.sessionId.trim() === "") {
          throw new Error("sessionId 不能为空");
        }
        const deleted = await listDeletedSessions(this.kcodeHomeDir);
        if (!deleted.has(p.sessionId)) throw new Error("只能永久清理回收站里的会话");
        await deleteSession(join(this.kcodeHomeDir, "cli", "sessions"), p.sessionId).catch(() => undefined);
        await removeSessionIndex(this.kcodeHomeDir, p.sessionId);
        await setArchived(this.kcodeHomeDir, p.sessionId, false);
        await setSessionDeleted(this.kcodeHomeDir, p.sessionId, false);
        this.#sessionsChanged("purge");
        return { sessionId: p.sessionId, purged: true };
      }
      case "sessions/empty_trash": {
        const deleted = await listDeletedSessions(this.kcodeHomeDir);
        for (const sessionId of deleted) {
          await deleteSession(join(this.kcodeHomeDir, "cli", "sessions"), sessionId).catch(() => undefined);
          await removeSessionIndex(this.kcodeHomeDir, sessionId);
          await setArchived(this.kcodeHomeDir, sessionId, false);
        }
        await clearDeletedSessions(this.kcodeHomeDir);
        this.#sessionsChanged("empty-trash");
        return { purged: deleted.size };
      }
      case "sessions/archive": {
        const p = params as { sessionId?: unknown; archived?: unknown };
        if (typeof p.sessionId !== "string" || p.sessionId.trim() === "") {
          throw new Error("sessionId 不能为空");
        }
        const archived = p.archived !== false;
        await setArchived(this.kcodeHomeDir, p.sessionId, archived);
        this.#sessionsChanged("archive");
        return { sessionId: p.sessionId, archived };
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
