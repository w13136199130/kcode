import { describe, it } from "vitest";
import { render } from "ink";
import { useState, type ReactElement } from "react";
import { InputBox, type CommandInfo } from "../src/tui/App.js";

const COMMANDS: CommandInfo[] = [];

function Harness(props: { onSubmit: (v: string) => void }): ReactElement {
  const [value, setValue] = useState("");
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={props.onSubmit}
      history={[]}
      commands={COMMANDS}
    />
  );
}

/** 真 Ink 渲染管线稳定桩（与 input-flat 共用形态） */
function makeHarness(onSubmit: (v: string) => void) {
  const frames: string[] = [];
  const stdout = {
    write(s: string) {
      frames.push(s);
      return true;
    },
    columns: 80,
    rows: 24,
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
      for (const fn of listeners) (fn as () => void)();
    },
  };
  const instance = render(<Harness onSubmit={onSubmit} />, {
    stdout: stdout as never,
    stdin: stdin as never,
  });
  return { frames, stdin, unmount: () => instance.unmount() };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("多行输入（Ctrl+J / 反斜杠续行 / 多行粘贴 / 多行渲染）", () => {
  it("Ctrl+J（\\n）插入换行：两行渲染，续行缩进；Enter 才提交", async () => {
    const submitted: string[] = [];
    const t = makeHarness((v) => submitted.push(v));
    await sleep(100);
    t.stdin.write("ab");
    await sleep(120);
    t.stdin.write("\n"); // Ctrl+J
    await sleep(150);
    t.stdin.write("cd");
    await sleep(300);
    const last = strip(t.frames.at(-1) ?? "");
    if (!last.includes("> ab") || !last.includes("cd█")) {
      throw new Error(`多行渲染缺失 last=${JSON.stringify(last)}`);
    }
    if (submitted.length !== 0) {
      throw new Error("换行被误提交");
    }
    t.stdin.write("\r"); // Enter
    await sleep(200);
    if (submitted[0] !== "ab\ncd") {
      throw new Error(`提交内容不符: ${JSON.stringify(submitted)}`);
    }
    t.unmount();
  }, 10_000);

  it("行尾反斜杠 + Enter 续行（\\ → 换行符，不提交）", async () => {
    const submitted: string[] = [];
    const t = makeHarness((v) => submitted.push(v));
    await sleep(100);
    t.stdin.write("abc\\");
    await sleep(150);
    t.stdin.write("\r");
    await sleep(200);
    t.stdin.write("def");
    await sleep(300);
    if (submitted.length !== 0) {
      throw new Error("续行被误提交");
    }
    const last = strip(t.frames.at(-1) ?? "");
    if (!last.includes("abc") || !last.includes("def█")) {
      throw new Error(`续行渲染缺失 last=${JSON.stringify(last)}`);
    }
    t.stdin.write("\r");
    await sleep(200);
    if (submitted[0] !== "abc\ndef") {
      throw new Error(`提交内容不符: ${JSON.stringify(submitted)}`);
    }
    t.unmount();
  }, 10_000);

  it("多行粘贴（单 chunk 含 \\n）：不提前提交，换行保留", async () => {
    const submitted: string[] = [];
    const t = makeHarness((v) => submitted.push(v));
    await sleep(100);
    t.stdin.write("line1\nline2");
    await sleep(400);
    if (submitted.length !== 0) {
      throw new Error("多行粘贴在首个换行处被误提交");
    }
    const last = strip(t.frames.at(-1) ?? "");
    if (!last.includes("> line1") || !last.includes("line2█")) {
      throw new Error(`粘贴多行渲染缺失 last=${JSON.stringify(last)}`);
    }
    t.stdin.write("\r");
    await sleep(200);
    if (submitted[0] !== "line1\nline2") {
      throw new Error(`提交内容不符: ${JSON.stringify(submitted)}`);
    }
    t.unmount();
  }, 10_000);
});
