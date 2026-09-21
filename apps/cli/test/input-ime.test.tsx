import { describe, expect, it } from "vitest";
import { render } from "ink";
import { useState, type ReactElement } from "react";
import { InputBox, type CommandInfo } from "../src/tui/App.js";

const COMMANDS: CommandInfo[] = [{ name: "mode", desc: "切换权限模式" }];

function Harness(): ReactElement {
  const [value, setValue] = useState("");
  // eslint-disable-next-line no-console
  console.error("DBG harness render", JSON.stringify(value));
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      history={["第一句"]}
      commands={COMMANDS}
    />
  );
}

interface FakeStdout {
  write(s: string): boolean;
  columns: number;
  isTTY: boolean;
  on(): void;
  removeListener(): void;
}

/** 真 Ink 渲染 + 可捕获帧的假 stdout/stdin：走完整渲染管线（含 throttle） */
function renderInput(): { frames: string[]; stdin: { write(s: string): void }; cleanup(): void } {
  const frames: string[] = [];
  const stdout = {
    write(s: string): boolean {
      frames.push(s);
      return true;
    },
    columns: 80,
    rows: 24,
    isTTY: true,
    on(): void {},
    off(): void {},
    removeListener(): void {},
  };
  const listeners: Array<(s: string) => void> = [];
  // readable 语义：write 入队，read 出队（Ink 的 handleReadable 循环 read 到 null 为止）
  let pending = "";
  const stdin = {
    setRawMode(): void {},
    ref(): void {},
    unref(): void {},
    isTTY: true,
    setEncoding(): void {},
    on(_ev: string, fn: (s: string) => void): void {
      listeners.push(fn);
    },
    addListener(_ev: string, fn: (s: string) => void): void {
      listeners.push(fn);
    },
    removeListener(_ev: string, fn: (s: string) => void): void {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    read(): string | null {
      const s = pending;
      pending = "";
      return s === "" ? null : s;
    },
    write(s: string): void {
      pending += s;
      // 模拟流的 readable 事件：唤醒 Ink 的 handleReadable 循环
      for (const fn of [...listeners]) fn();
    },
  };
  const instance = render(<Harness />, {
    stdout: stdout as unknown as typeof process.stdout,
    stdin: stdin as unknown as typeof process.stdin,
  });
  return {
    frames,
    stdin,
    cleanup: () => instance.unmount(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 全部帧拼接后的可见文本 */
function lastVisible(frames: string[]): string {
  return frames.join("");
}

describe("InputBox 逐键回显（真 Ink 渲染管线）", () => {
  it("中文整串上屏立即出现在帧里", async () => {
    const t = renderInput();
    await sleep(80);
    const before = lastVisible(t.frames);
    t.stdin.write("你是");
    await sleep(120);
    // eslint-disable-next-line no-console
    console.error("F1:", JSON.stringify(t.frames));
    const after = lastVisible(t.frames);
    expect(after).toContain("你是");
    expect(after.length).toBeGreaterThan(before.length);
    t.cleanup();
  });

  it("拼音泄漏 → 中文替换后帧里无残留", async () => {
    const t = renderInput();
    await sleep(80);
    t.stdin.write("ni");
    await sleep(80);
    t.stdin.write("你是");
    await sleep(150);
    console.error("F4:", JSON.stringify(t.frames));
    const frame = t.frames.at(-1) ?? "";
    expect(frame).toContain("你是");
    t.cleanup();
  });

  it("↑ 切历史立即出现在帧里", async () => {
    const t = renderInput();
    await sleep(80);
    t.stdin.write("第一句");
    await sleep(80);
    t.stdin.write("\r");
    await sleep(80);
    t.stdin.write("x");
    await sleep(80);
    t.stdin.write("\x1b[A");
    await sleep(150);
    const frame = t.frames.at(-1) ?? "";
    expect(frame).toContain("第一句");
    t.cleanup();
  });
});
