import { BUILTIN_COMMANDS, type CommandInfo, type PermissionMode } from "@kcode/contracts";
import type { HostConnection } from "@web/hooks/useHostConnection.js";
import type { MutableRefObject } from "react";
import type { TimelineState } from "../components/projection.js";

/**
 * D1-05：桌面斜杠命令分发。内置命令只实现桌面可闭环的子集；
 * 自定义命令经 host `session/command` 展开为 prompt 再提交。
 */
export function useDesktopCommands(opts: {
  conn: HostConnection;
  commands: CommandInfo[];
  mode: PermissionMode;
  sessionId: string | null;
  modelDefault: string | null;
  queuedCount: number;
  onNewSessionRef: MutableRefObject<(() => void) | null>;
  setMode(mode: PermissionMode): void;
  setTimeline(action: (prev: TimelineState) => TimelineState): void;
}) {
  const pushInfo = (text: string, tone?: "ok" | "warn" | "deny"): void => {
    opts.setTimeline((prev) => ({
      ...prev,
      rows: [...prev.rows, { kind: "info", text, ...(tone !== undefined ? { tone } : {}) }],
    }));
  };
  const submitText = (text: string, images?: readonly string[]): void => {
    opts.setTimeline((prev) => ({ ...prev, busy: true }));
    void opts.conn
      .send("session/submit", { text, ...(images !== undefined && images.length > 0 ? { images: [...images] } : {}) })
      .catch(() => opts.setTimeline((prev) => ({ ...prev, busy: false })));
  };
  const runSlash = async (name: string, args: string): Promise<void> => {
    if (name === "clear") {
      opts.onNewSessionRef.current?.();
      return;
    }
    if (name === "exit") {
      window.close();
      return;
    }
    if (name === "mode" || name === "plan") {
      const next = name === "plan" ? (opts.mode === "plan" ? "default" : "plan") : args.trim();
      if (!["plan", "default", "acceptEdits", "fullAccess"].includes(next)) {
        pushInfo("用法：/mode plan|default|acceptEdits|fullAccess", "warn");
        return;
      }
      opts.setMode(next as PermissionMode);
      void opts.conn.send("session/set_mode", { mode: next }).catch(() => undefined);
      pushInfo(`⇄ 已切换：${next}`, "ok");
      return;
    }
    if (name === "compact") {
      const r = (await opts.conn.send("session/compact").catch(() => null)) as { dropped?: number } | null;
      pushInfo(r?.dropped !== undefined ? `已压缩（丢弃 ${r.dropped} 条）` : "当前无需压缩", "ok");
      return;
    }
    if (name === "help") {
      pushInfo(
        opts.commands
          .filter((c) => c.hidden !== true)
          .map((c) => `/${c.name}${c.argsHint !== undefined ? ` ${c.argsHint}` : ""} — ${c.desc}`)
          .join("\n"),
      );
      return;
    }
    if (name === "status") {
      pushInfo(
        `会话 ${opts.sessionId?.slice(0, 16) ?? "—"} · 模型 ${opts.modelDefault ?? "—"} · 模式 ${opts.mode} · 排队 ${opts.queuedCount}`,
      );
      return;
    }
    if (name === "resume") {
      pushInfo("请用左侧会话列表切换/续接会话", "warn");
      return;
    }
    if (BUILTIN_COMMANDS.some((c) => c.name === name)) {
      pushInfo(`桌面暂未接入 /${name}（CLI 可用）`, "warn");
      return;
    }
    const expanded = (await opts.conn.send("session/command", { name, args }).catch(() => null)) as {
      text?: string;
    } | null;
    if (expanded?.text === undefined) {
      pushInfo(`未知命令 /${name}（/help 查看可用命令）`, "deny");
      return;
    }
    submitText(expanded.text);
  };
  const onSend = (text: string, images?: readonly string[]): void => {
    const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (m !== null) {
      void runSlash(m[1]!, m[2] ?? "");
      return;
    }
    submitText(text, images);
  };
  return { onSend, pushInfo };
}
