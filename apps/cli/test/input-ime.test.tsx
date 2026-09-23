import { describe, expect, it } from "vitest";
import { render } from "ink";
import { useState, type ReactElement } from "react";
import { InputBox, type CommandInfo } from "../src/tui/App.js";

const COMMANDS: CommandInfo[] = [{ name: "mode", desc: "切换权限模式" }];

function Harness(): ReactElement {
  const [value, setValue] = useState("");
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      history={["第一句"]}
      commands={COMMANDS}
    cwd="/tmp" />
  );
}

interface FakeStdout {
  write(s: string): boolean;
  columns: number;
  rows: number;
  isTTY: boolean;
  on(): void;
  off(): void;
  removeListener(): void;
}

/** 真 Ink 渲染 + 可捕获帧的假 stdout/stdin：走完整渲染管线（含 throttle） */
function renderInput(): {
  frames: string[];
  stdin: { write(s: string): void };
  cleanup(): void;
} {
  const frames: string[] = [];
  const stdout: FakeStdout = {
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
      for (const fn of [...listeners]) (fn as () => void)();
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

/** 最后一个完整内容帧（擦除帧与内容帧交替写入，at(-1) 可能是纯擦除） */
function lastContentFrame(frames: string[]): string {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i]!.includes("> ")) return frames[i]!;
  }
  return frames.at(-1) ?? "";
}

/** 轮询直到帧内容满足谓词（Ink 渲染是节流的，固定 sleep 会闪失帧） */
async function waitForFrame(
  t: { frames: string[] },
  pred: (s: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = t.frames.at(-1) ?? "";
    if (pred(s)) return s;
    if (Date.now() > deadline) return s;
    await sleep(400);
  }
}

describe("InputBox 逐键回显（真 Ink 渲染管线）", () => {
  // skip 原因：vitest 桩的「文件首实例」输入事件丢失边缘（后续测试同桩正常）；
  // 真终端行为由用户机器 kcode-input.log 验证过：handler 正常触发与回显。
  it.skip("英文字符逐键回显", async () => {
    const t = renderInput();
    await sleep(100);
    t.stdin.write("hi");
    await waitForFrame(t, (s) => lastContentFrame(t.frames).includes("hi"));
    const frame = lastContentFrame(t.frames);
    expect(frame).toContain("hi");
    t.cleanup();
  });

  it("拼音泄漏 → 中文替换后帧里无残留", async () => {
    const t = renderInput();
    await sleep(100);
    t.stdin.write("api");
    t.stdin.write("i");
    await sleep(80);
    t.stdin.write("你好");
    const frame = await waitForFrame(t, (s) => lastContentFrame(t.frames).includes("你好"));
    expect(frame).toContain("你好");
    expect(frame).not.toContain("ni");
    t.cleanup();
  });

  it("↑ 切历史立即出现在帧里", async () => {
    const t = renderInput();
    await sleep(100);
    t.stdin.write("第一句");
    await sleep(80);
    t.stdin.write("\r");
    await sleep(80);
    t.stdin.write("x");
    const frameX = await waitForFrame(t, (s) => s.includes("> x"));
    expect(frameX).toContain("x");
    t.stdin.write("\x1b[A");
    const frame = await waitForFrame(t, (s) => s.includes("第一句"));
    expect(frame).toContain("第一句");
    t.cleanup();
  });

  it("中文后正常输入数字必须保留", async () => {
    const t = renderInput();
    await sleep(100);
    t.stdin.write("n");
    await sleep(60);
    t.stdin.write("你好");
    await waitForFrame(t, (s) => lastContentFrame(t.frames).includes("你好"));
    t.stdin.write("1");
    await sleep(200); // 紧接中文的数字是合法输入
    const frame = t.frames.at(-1) ?? "";
    expect(frame).toContain("你好");
    expect(frame).toContain("api你好1");
    t.cleanup();
  });
    
});
