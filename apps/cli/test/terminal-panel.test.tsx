import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { render as renderInk } from "ink";
import type { SandboxPtySession } from "@kcode/sandbox";
import { TerminalPanel } from "../src/tui/terminal/TerminalPanel.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

function fakeSession(): SandboxPtySession & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write: (data) => writes.push(data),
    resize: () => {},
    kill: () => {},
    onData: (callback) => {
      callback("hello from pty\n");
      return () => {};
    },
    onExit: () => () => {},
  };
}

function setup(session: SandboxPtySession, onClose: () => void) {
  const stdin = new FakeTtyStdin();
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 30,
    isTTY: true,
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
  });
  const instance = renderInk(<TerminalPanel session={session} onClose={onClose} />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { instance, stdin, lastFrame: () => frames.at(-1) ?? "" };
}

describe("TerminalPanel", () => {
  it("渲染 PTY 输出并标注不受 srt 保护", async () => {
    const t = setup(fakeSession(), () => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = t.lastFrame();
    expect(frame, JSON.stringify(frame)).toContain("PTY 交互终端（不受 srt 保护）");
    expect(frame).toContain("hello from pty");
    t.instance.unmount();
    t.stdin.destroy();
  });

  it("把按键写入 PTY；Ctrl+] 关闭并 kill", async () => {
    const session = fakeSession();
    const close = vi.fn();
    const t = setup(session, close);
    await new Promise((resolve) => setTimeout(resolve, 30));
    t.stdin.write("x");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.writes).toContain("x");
    t.stdin.write("\u001d");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(close).toHaveBeenCalled();
    t.instance.unmount();
    t.stdin.destroy();
  });
});
