import { EventEmitter } from "node:events";
import { render } from "ink";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { InputBox } from "../src/tui/input/InputBox.js";
import { GHOST_HINT } from "../src/tui/input/suggestions.js";
import { formatHelp } from "../src/tui/input/help.js";
import { lineEnd, lineStart, wordLeft, wordRight } from "../src/tui/input/editing.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/** 3-24 输入编辑键：纯语义（行/词边界）+ 真实 Ink 键位链路（Ctrl/A/E/U/K/W、Alt/Ctrl+←→） */

const CWD = process.cwd();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("行/词边界纯函数", () => {
  it("lineStart/lineEnd 按行（含首行、末尾、换行处）", () => {
    const text = "abc\ndef\n";
    expect(lineStart(text, 0)).toBe(0);
    expect(lineStart("\nabc", 0)).toBe(0); // 文首换行：pos=0 仍是首行行首
    expect(lineStart(text, 5)).toBe(4);
    expect(lineEnd(text, 4)).toBe(7);
    expect(lineEnd(text, 5)).toBe(7);
    expect(lineStart(text, 8)).toBe(8);
    expect(lineEnd(text, 8)).toBe(8);
  });

  it("wordLeft：跳过空白与标点，停在词首；无词时回缓冲区开头", () => {
    expect(wordLeft("foo bar baz", 11)).toBe(8);
    expect(wordLeft("foo bar baz", 8)).toBe(4);
    expect(wordLeft("foo bar.", 8)).toBe(4); // "bar." 前是空格
    expect(wordLeft("src/auth.ts", 11)).toBe(9); // 标点分词：ts
    expect(wordLeft("   ", 3)).toBe(0);
    expect(wordLeft("你好 世界", 5)).toBe(3);
    expect(wordLeft("abc", 0)).toBe(0);
  });

  it("wordRight：停在下个词起点（或文末）", () => {
    expect(wordRight("foo bar", 0)).toBe(4);
    expect(wordRight("foo bar", 4)).toBe(7);
    expect(wordRight("foo bar", 7)).toBe(7);
    expect(wordRight("你好 世界", 0)).toBe(3);
    expect(wordRight("   ", 0)).toBe(3);
  });
});

function Harness(props: { onSubmit(value: string): void }) {
  const [value, setValue] = useState("");
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={props.onSubmit}
      history={[]}
      commands={[]}
      cwd={CWD}
    />
  );
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function mount() {
  const submits: string[] = [];
  const stdin = new FakeTtyStdin();
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 30,
    isTTY: true,
    write: () => true,
  });
  const instance = render(<Harness onSubmit={(v) => submits.push(v)} />, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
  });
  const type = async (text: string) => {
    stdin.write(text);
    await sleep(140);
  };
  return { type, submits, stdin };
}

// Ink 键位：Ctrl+字母 = 控制字符；Alt/Ctrl+方向 = CSI 1;<mod><方向>
const CTRL = (letter: string): string => String.fromCharCode(letter.charCodeAt(0) - 96);
const ALT_LEFT = "\x1b[1;3D";
const CTRL_RIGHT = "\x1b[1;5C";

describe("InputBox 编辑键（真实 Ink 渲染）", () => {
  it("Ctrl+A/E 行首行尾；Ctrl+J 换行后仍按行定位", async () => {
    const t = mount();
    await t.type("abc");
    await t.type("\n"); // Ctrl+J → 换行
    await t.type("def");
    await t.type(CTRL("a")); // 第二行行首
    await t.type("1");
    await t.type(CTRL("e")); // 第二行行尾
    await t.type("2");
    await t.type("\r");
    expect(t.submits).toEqual(["abc\n1def2"]);
  });

  it("Ctrl+U 删到行首、Ctrl+K 删到行尾（行级，不影响上一行）", async () => {
    const t = mount();
    await t.type("one");
    await t.type("\n");
    await t.type("two three");
    await t.type(CTRL("a")); // 第二行行首
    await t.type(CTRL("k")); // 删掉 "two three"
    await t.type("TWO");
    await t.type(CTRL("u")); // 再删到行首
    await t.type("\r");
    expect(t.submits).toEqual(["one\n"]);
  });

  it("Ctrl+K 在行尾删掉换行符（合并下一行）", async () => {
    const t = mount();
    await t.type("one");
    await t.type("\n");
    await t.type("two");
    // ← 四次：从 "two|" 退到第一行行尾 "one|"
    for (let i = 0; i < 4; i++) {
      await t.type("\x1b[D");
    }
    await t.type(CTRL("k")); // 删换行 → "onetwo"
    await t.type("X");
    await t.type("\r");
    expect(t.submits).toEqual(["oneXtwo"]);
  });

  it("Ctrl+W 删前一词；Alt+Left / Ctrl+Right 按词移动", async () => {
    const t = mount();
    await t.type("foo bar baz");
    await t.type(CTRL("w")); // 删 baz
    await t.type(CTRL("w")); // 删 bar + 尾空格
    await t.type(ALT_LEFT); // 词首 foo
    await t.type("X");
    await t.type(CTRL_RIGHT); // 跳到下一个词起点（行尾）
    await t.type("Y");
    await t.type("\r");
    expect(t.submits).toEqual(["Xfoo Y"]);
  });
});

describe("帮助与 ghost 发现性", () => {
  it("/help 写明 Ctrl+G/Ctrl+J 与行编辑键，不再宣传 Ctrl+E 编辑器", () => {
    const help = formatHelp([]);
    expect(help).toContain("Ctrl+G 外部编辑器");
    expect(help).toContain("Ctrl+J 输入换行");
    expect(help).toContain("Ctrl+A/E 行首/行尾");
    expect(help).toContain("Ctrl+W 删前一词");
    expect(help).not.toContain("Ctrl+E 外部编辑器");
  });

  it("ghost 提示包含 Ctrl+J 换行", () => {
    expect(GHOST_HINT).toContain("Ctrl+J 换行");
    expect(GHOST_HINT).toContain("Ctrl+G 编辑");
  });
});
