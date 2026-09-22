import { describe, it } from "vitest";
import { render } from "ink";
import { useState, type ReactElement } from "react";
import { InputBox, type CommandInfo } from "../src/tui/App.js";

const COMMANDS: CommandInfo[] = [];

function Harness(): ReactElement {
  const [value, setValue] = useState("");
  return <InputBox value={value} onChange={setValue} onSubmit={() => {}} history={[]} commands={COMMANDS} cwd="/tmp" />;
}

/** 真 Ink 渲染管线稳定桩（与 input-ime 共用形态） */
function makeHarness(ui: ReactElement) {
  const frames: string[] = [];
  const stdout = {
    write(s: string) { frames.push(s); return true; },
    columns: 80, rows: 24, isTTY: true,
    on() {}, off() {}, removeListener() {},
  };
  const listeners: Array<() => void> = [];
  let pending = "";
  const stdin = {
    setRawMode() {}, ref() {}, unref() {}, isTTY: true, setEncoding() {},
    on(_e: string, fn: () => void) { listeners.push(fn); },
    addListener(_e: string, fn: () => void) { listeners.push(fn); },
    removeListener() {},
    read() { const s = pending; pending = ""; return s === "" ? null : s; },
    write(s: string) { pending += s; for (const fn of [...listeners]) (fn as () => void)(); },
  };
  const instance = render(ui, { stdout: stdout as never, stdin: stdin as never });
  return { frames, stdin, unmount: () => instance.unmount() };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 回归：退格后中文上屏必须出现在输出帧里。
 * 根因：嵌套 <Text inverse> 光标在快速连续变更（退格→上屏）下触发 Ink 内部
 * 丢失 CJK（状态/渲染正确、输出帧缺失——经 stdout 帧捕获最小复现）；
 * 输入行已改为纯扁平单字符串 + █ 块光标渲染。
 */
describe("输入行扁平渲染回归（Ink CJK 丢失 bug）", () => {
  it("预热→退格→中文上屏：帧含 CJK", async () => {
    const t = makeHarness(<Harness />);
    await sleep(100);
    t.stdin.write("x");
    await sleep(120);
    t.stdin.write("\x7f");
    await sleep(150);
    t.stdin.write("你好");
    await sleep(300);
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const last = t.frames.filter((f) => strip(f).includes(">")).at(-1) ?? "";
    if (!last.includes("你好")) {
      throw new Error(`CJK 丢失 last=${JSON.stringify(strip(last))}`);
    }
    t.unmount();
  });

  it("直接中文上屏：帧含 CJK", async () => {
    const t = makeHarness(<Harness />);
    await sleep(100);
    t.stdin.write("x");
    await sleep(120);
    t.stdin.write("你好");
    await sleep(300);
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const last = t.frames.filter((f) => strip(f).includes(">")).at(-1) ?? "";
    if (!last.includes("你好")) {
      throw new Error(`CJK 丢失 last=${JSON.stringify(strip(last))}`);
    }
    t.unmount();
  });
});
