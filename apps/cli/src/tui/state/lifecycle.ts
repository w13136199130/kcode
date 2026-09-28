import { useEffect } from "react";
import type { PermissionAsker, SessionEvent, UserPromptPort } from "@kcode/contracts";
import type { Block, UiStore } from "@kcode/ui";
import type { Runtime } from "../../bootstrap.js";
import { loadInputHistory } from "../../history-store.js";
import type { QueuedCommand } from "@kcode/runtime";
import type { LocalSessionOptions, SessionHandle } from "../../session.js";
import type { CommandInfo } from "../input/builtin-commands.js";
import { BUILTIN_COMMANDS } from "../input/builtin-commands.js";
import type { StreamController } from "./stream.js";

/** 会话生命周期入参（N2-3 外迁）：App 侧最小依赖面 */
export interface LifecycleDeps {
  props: {
    runtime: Runtime;
    cwd: string;
    historyFile?: string;
    resumeFrom?: string;
    oneShot?: string;
    images?: string[];
    model: string;
  };
  ui: UiStore;
  stream: StreamController;
  createSession(opts: LocalSessionOptions): Promise<SessionHandle>;
  sessionRef: { current: SessionHandle | null };
  inputHistory: { current: string[] };
  handleEvent(event: SessionEvent): void;
  asker: PermissionAsker;
  askUser: UserPromptPort;
  onPlanApproval: NonNullable<LocalSessionOptions["onPlanApproval"]>;
  beginWork(): void;
  setReady(v: boolean): void;
  setFatal(v: string | null): void;
  setCommands(cmds: CommandInfo[]): void;
  pushBlock(block: Block): void;
  modelLabel: string;
  exit(): void;
}

/**
 * 会话生命周期（N2-3 外迁）：挂载时装配初始会话（resume/一次性提问/命令合并），
 * /resume 换建续接会话。事件/增量/交互回调直连引擎，排队镜像经 commandQueue.onChange。
 */
export function useSessionLifecycle(deps: LifecycleDeps): { switchSession(resumeFrom: string): void } {
  const { props, ui, stream, createSession, sessionRef, handleEvent, asker, askUser, onPlanApproval, pushBlock } = deps;
  const onQueueChange = (items: readonly QueuedCommand[]): void => {
    ui.getState().setQueuedCount(items.length);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const handle = await createSession({
          runtime: props.runtime,
          model: props.model,
          cwd: props.cwd,
          resumeFrom: props.resumeFrom,
          onEvent: (e) => {
            if (!cancelled) handleEvent(e);
          },
          onDelta: (d) => {
            if (!cancelled) stream.appendDelta(d);
          },
          onReasoning: (d) => {
            if (!cancelled) stream.appendReasoning(d);
          },
          onNotice: (n) => {
            if (!cancelled) ui.getState().setNotice(n);
          },
          asker,
          askUser,
          onPlanApproval,
          onQueueChange,
        });
        sessionRef.current = handle;
        deps.setReady(true);
        deps.inputHistory.current = (await loadInputHistory(props.historyFile)).slice(-50);
        pushBlock({ kind: "banner", model: props.model, cwd: props.cwd });
        // 自定义命令并入补全菜单（预取异步完成晚于就绪时，600ms 后补读一次）
        const mergeCommands = (): void => {
          deps.setCommands([
            ...BUILTIN_COMMANDS,
            ...handle.listCommands().map((c) => ({
              name: c.name,
              desc: c.source === "project" ? "（项目自定义命令）" : "（用户自定义命令）",
            })),
          ]);
        };
        mergeCommands();
        setTimeout(mergeCommands, 600);
        if (props.oneShot !== undefined) {
          deps.beginWork();
          try {
            await handle.loop.run(
              props.oneShot,
              props.images !== undefined ? { images: props.images } : {},
            );
          } finally {
            ui.getState().finish();
            setTimeout(() => deps.exit(), 80);
          }
        }
      } catch (err) {
        if (!cancelled) {
          const raw = err instanceof Error ? err.message : String(err);
          // keychain 报错 = 当前进程环境未设口令——给出可操作修复步骤
          const hint = raw.includes("KCODE_KEYCHAIN_PASSPHRASE")
            ? "\n\n修复：在当前终端设置 keychain 口令后重启 kcode——\n" +
              '  1) 设置口令：PowerShell $env:KCODE_KEYCHAIN_PASSPHRASE="..." ／ cmd set KCODE_KEYCHAIN_PASSPHRASE=...\n' +
              "  2) 重新运行 npx tsx src/main.tsx（或 kcode key add 重新录入）"
            : "";
          deps.setFatal(raw + hint);
          setTimeout(() => deps.exit(), 80);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** /resume：换建一个续接旧会话历史的新会话并切换为当前会话（旧转写保留在上方作上下文） */
  const switchSession = (resumeFrom: string): void => {
    if (ui.getState().busy) {
      pushBlock({ kind: "info", tone: "warn", text: "运行中不能续接会话（等本轮完成或 Esc 中断）" });
      return;
    }
    // 换会话语义：旧会话的排队输入不带走（防悬挂；计数经旧队列 onChange 归零）
    const stale = sessionRef.current?.commandQueue.clear() ?? 0;
    if (stale > 0) {
      pushBlock({ kind: "info", tone: "warn", text: `已清空 ${stale} 条排队输入（续接不带旧排队）` });
    }
    deps.beginWork();
    void (async () => {
      try {
        const handle = await createSession({
          runtime: props.runtime,
          model: deps.modelLabel,
          cwd: props.cwd,
          resumeFrom,
          onEvent: handleEvent,
          onDelta: stream.appendDelta,
          onReasoning: stream.appendReasoning,
          onNotice: (n) => ui.getState().setNotice(n),
          asker,
          askUser,
          onPlanApproval,
          onQueueChange,
        });
        sessionRef.current = handle;
        ui.getState().resetTranscript();
        pushBlock({
          kind: "info",
          tone: "ok",
          text: `⭄ 已切换到续接会话 ${handle.sessionId.slice(0, 16)}…（模型 ${deps.modelLabel}）`,
        });
      } catch (err) {
        pushBlock({
          kind: "info",
          tone: "warn",
          text: `✗ 续接失败：${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        ui.getState().finish();
      }
    })();
  };

  return { switchSession };
}
