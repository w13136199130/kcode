import { describe, expect, it } from "vitest";
import { render } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import { InputBox } from "../src/tui/input/InputBox.js";
import type { CommandInfo } from "../src/tui/input/builtin-commands.js";

/** N3G-2：InputBox 级 undo/redo 集成——合并窗口、粘贴/提交边界、Ctrl+Z/Y 键 */

const COMMANDS: CommandInfo[] = [];

function Harness(props: { report: (v: string) => void; onSubmit: (v: string) => void }): ReactElement {
  const [value, setValue] = useState("");
  useEffect(() => {
    props.report(value);
  }, [value, props.report]);
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={(v) => {
        props.onSubmit(v);
        setValue(""); // 对齐 App：提交后清空
      }}
      history={[]}
      commands={COMMANDS}
      cwd="/tmp"
    />
  );
}

function makeHarness() {
  const frames: string[] = [];
  const values: string[] = [];
  const submits: string[] = [];
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
      for (const fn of [...listeners]) (fn as () => void)();
    },
  };
  const report = (v: string): void => {
    values.push(v);
  };
  const onSubmit = (v: string): void => {
    submits.push(v);
  };
  const instance = render(<Harness report={report} onSubmit={onSubmit} />, {
    stdout: stdout as never,
    stdin: stdin as never,
  });
  return {
    stdin,
    values,
    submits,
    value: () => values.at(-1) ?? "",
    unmount: () => instance.unmount(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("N3G-2 输入 undo/redo", () => {
  it("快打合并：一串连打一次 Ctrl+Z 全撤；分时输入逐块撤；Ctrl+Y 重做", async () => {
    const t = makeHarness();
    await sleep(80);
    // 逐键间隔 20ms（<100ms 合并窗，但确保 Ink 分帧消费——假 stdin 会合并同拍写入）
    t.stdin.write("a");
    await sleep(20);
    t.stdin.write("b");
    await sleep(20);
    t.stdin.write("c");
    await sleep(150);
    expect(t.value()).toBe("abc");
    t.stdin.write("d"); // 过窗 → 第二单元
    await sleep(150);
    expect(t.value()).toBe("abcd");

    t.stdin.write("\x1a"); // Ctrl+Z → 回 "abc"
    await sleep(120);
    expect(t.value()).toBe("abc");
    t.stdin.write("\x1a"); // Ctrl+Z → 回 ""
    await sleep(120);
    expect(t.value()).toBe("");
    t.stdin.write("\x19"); // Ctrl+Y → 重做 "abc"
    await sleep(120);
    expect(t.value()).toBe("abc");
    t.stdin.write("\x19"); // Ctrl+Y → 重做 "abcd"
    await sleep(120);
    expect(t.value()).toBe("abcd");
    t.unmount();
  });

  it("粘贴（多字符一次插入）即使窗口内也是独立单元", async () => {
    const t = makeHarness();
    await sleep(80);
    t.stdin.write("x");
    await sleep(30); // 确保 Ink 已消费首键（假 stdin 同拍写入会并块）
    t.stdin.write("yz"); // 多字符 = 边界（粘贴/IME 上屏）
    await sleep(150);
    expect(t.value()).toBe("xyz");
    t.stdin.write("\x1a"); // 撤粘贴 → 回 "x"
    await sleep(120);
    expect(t.value()).toBe("x");
    t.unmount();
  });

  it("提交后清空：Ctrl+Z 找回草稿", async () => {
    const t = makeHarness();
    await sleep(80);
    t.stdin.write("hello");
    await sleep(150);
    t.stdin.write("\r");
    await sleep(150);
    expect(t.submits).toEqual(["hello"]);
    expect(t.value()).toBe("");
    t.stdin.write("\x1a"); // 误触回车的后悔药
    await sleep(120);
    expect(t.value()).toBe("hello");
    t.unmount();
  });
});
