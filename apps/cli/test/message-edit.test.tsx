import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { render as renderInk } from "ink";
import { ServicesProvider } from "@kcode/ui";
import { MessageEditPanel, MessagePickerPanel } from "../src/tui/dialogs/panels.js";
import type { CliServices } from "../src/tui/state/services.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

function mount(node: React.ReactNode, dialogs: Record<string, unknown>) {
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
  const instance = renderInk(
    <ServicesProvider services={{ dialogs } as unknown as CliServices}>{node}</ServicesProvider>,
    {
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  return { instance, stdin, frame: () => frames.at(-1) ?? "" };
}

describe("4-06.1 消息编辑面板", () => {
  it("选择提问后打开编辑面板，并预填完整文本", async () => {
    const setMessagePicker = vi.fn();
    const setMessageEdit = vi.fn();
    const t = mount(
      <MessagePickerPanel
        picker={{ points: [{ eventIndex: 3, preview: "旧提问", text: "旧提问完整内容", ts: 0, fileChanges: 0 }] }}
      />,
      { setMessagePicker, setMessageEdit },
    );
    await new Promise((r) => setTimeout(r, 30));
    t.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(setMessagePicker).toHaveBeenCalledWith(null);
    expect(setMessageEdit).toHaveBeenCalledWith({ eventIndex: 3, text: "旧提问完整内容" });
    t.instance.unmount();
    t.stdin.destroy();
  });

  it("回车提交编辑后的文本，Esc 取消", async () => {
    const retryMessage = vi.fn(async () => {});
    const setMessageEdit = vi.fn();
    const t = mount(<MessageEditPanel edit={{ eventIndex: 7, text: "原提问" }} />, {
      retryMessage,
      setMessageEdit,
    });
    await new Promise((r) => setTimeout(r, 30));
    t.stdin.write("!");
    await new Promise((r) => setTimeout(r, 30));
    t.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(retryMessage).toHaveBeenCalledWith(7, "原提问!");
    expect(setMessageEdit).toHaveBeenCalledWith(null);
    t.instance.unmount();
    t.stdin.destroy();
  });
});
