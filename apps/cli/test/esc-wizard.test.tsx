import { describe, expect, it } from "vitest";
import { render } from "ink";
import { type ReactElement } from "react";
import { PromptInput } from "../src/tui/dialogs/PromptInput.js";
import { HiddenInput } from "../src/tui/dialogs/HiddenInput.js";
import { OptionsMenu } from "../src/tui/dialogs/OptionsMenu.js";
import { LoginWizardPanel } from "../src/tui/dialogs/LoginWizardPanel.js";
import { ServicesProvider, createUiStore } from "@kcode/ui";

/** 对齐批 A：Esc 可发现性三件套 + 向导空输入退格回退 */

function mount(ui: ReactElement) {
  const frames: string[] = [];
  const stdout = {
    write(s: string) {
      frames.push(s);
      return true;
    },
    columns: 100,
    rows: 30,
    isTTY: true,
    on() {},
    off() {},
    removeListener() {},
  };
  const listeners: Array<() => void> = [];
  let pending = "";
  const stdin = {
    setRawMode() {},
    ref() {},
    unref() {},
    isTTY: true,
    setEncoding() {},
    on(_e: string, fn: () => void) {
      listeners.push(fn);
    },
    addListener(_e: string, fn: () => void) {
      listeners.push(fn);
    },
    removeListener() {},
    read() {
      const s = pending;
      pending = "";
      return s === "" ? null : s;
    },
    write(s: string) {
      pending += s;
      for (const fn of [...listeners]) (fn as () => void)();
    },
  };
  const instance = render(ui, { stdout: stdout as never, stdin: stdin as never });
  return {
    stdin,
    frameWith: (sub: string): string => [...frames].reverse().find((f) => f.includes(sub)) ?? "",
    lastFrame: () => frames.at(-1) ?? "",
    unmount: () => instance.unmount(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("A4 空输入退格 = 上一步", () => {
  it("PromptInput：空值退格触发 onBack；有值退格是编辑不触发", async () => {
    const calls: string[] = [];
    const t = mount(
      <PromptInput
        label="模型名: "
        initialValue=""
        onDone={() => calls.push("done")}
        onCancel={() => calls.push("cancel")}
        onBack={() => calls.push("back")}
      />,
    );
    await sleep(80);
    t.stdin.write("\x7f"); // 退格（空值）
    await sleep(120);
    expect(calls).toEqual(["back"]);
    t.unmount();

    const calls2: string[] = [];
    const t2 = mount(
      <PromptInput
        label="x: "
        initialValue="abc"
        onDone={() => calls2.push("done")}
        onCancel={() => calls2.push("cancel")}
        onBack={() => calls2.push("back")}
      />,
    );
    await sleep(80);
    t2.stdin.write("\x7f"); // 有值：编辑（不触发 back，也不经 onDone）
    await sleep(120);
    expect(calls2).toEqual([]);
    t2.unmount();
  });

  it("HiddenInput：空值退格触发 onBack；Esc 取消不变", async () => {
    const calls: string[] = [];
    const t = mount(
      <HiddenInput
        label="key: "
        onDone={() => calls.push("done")}
        onCancel={() => calls.push("cancel")}
        onBack={() => calls.push("back")}
      />,
    );
    await sleep(80);
    t.stdin.write("\x7f");
    await sleep(120);
    expect(calls).toEqual(["back"]);
    t.stdin.write("\x1b");
    await sleep(120);
    expect(calls).toEqual(["back", "cancel"]);
    t.unmount();
  });
});

describe("A2 login 向导可发现性", () => {
  it("2-5 段标题含（Esc 取消），底部有统一提示行（含上一步）", async () => {
    const ui = createUiStore();
    const wizard = {
      stage: "model" as const,
      providerName: "deepseek",
      presetBaseURL: "https://x/v4",
      presetModel: "deepseek-chat",
      baseURL: "https://x/v4",
      apiKey: "",
      model: "deepseek-chat",
    };
    const t = mount(
      <ServicesProvider
        services={{
          platform: { secureStorageAvailable: false, probe: async () => false, saveKey: async () => {} },
          ui,
          getSession: () => null,
          dialogs: {} as never,
        }}
      >
        <LoginWizardPanel wizard={wizard} />
      </ServicesProvider>,
    );
    await sleep(120);
    const frame = t.frameWith("模型名");
    expect(frame).toContain("Esc 取消");
    expect(frame).toContain("上一步");
    t.unmount();
  });
});

describe("A3 AskPanel 取消语义", () => {
  it("OptionsMenu cancelLabel 生效（Esc = 拒绝）；默认仍是 Esc 取消", async () => {
    const t = mount(
      <OptionsMenu
        cancelLabel="Esc = 拒绝"
        options={[{ key: "y", label: "允许" }]}
        onPick={() => {}}
        onCancel={() => {}}
      />,
    );
    await sleep(80);
    expect(t.frameWith("Esc = 拒绝")).toContain("Esc = 拒绝");
    t.unmount();

    const t2 = mount(<OptionsMenu options={[{ key: "y", label: "允许" }]} onPick={() => {}} onCancel={() => {}} />);
    await sleep(80);
    expect(t2.frameWith("Esc 取消")).toContain("Esc 取消");
    t2.unmount();
  });
});
