import { describe, expect, it } from "vitest";
import { render } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import { InputBox } from "../src/tui/input/InputBox.js";
import type { CommandInfo } from "../src/tui/input/builtin-commands.js";

/** 斜杠命令菜单对齐批：可达性滚动窗 / 子串匹配 / Enter 执行 / Esc 保留输入 / 计数 */

const COMMANDS: CommandInfo[] = Array.from({ length: 12 }, (_, i) => ({
  name: `cmd${String(i + 1).padStart(2, "0")}`,
  desc: `命令 ${i + 1}`,
})).concat([
  { name: "context", desc: "上下文" },
  { name: "compact", desc: "压缩" },
]);

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
        setValue("");
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
    submits,
    value: () => values.at(-1) ?? "",
    frameWith: (sub: string): string => [...frames].reverse().find((f) => f.includes(sub)) ?? "",
    unmount: () => instance.unmount(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B";

describe("斜杠命令菜单（对齐批）", () => {
  it("可达性：↓ 超出可见窗口后选中项滚入视野（修复截断不可选 bug）", async () => {
    const t = makeHarness();
    await sleep(80);
    t.stdin.write("/");
    await sleep(150);
    expect(t.frameWith("> /")).toContain("❯ /cmd01"); // 12 个 cmd + context + compact

    for (let i = 0; i < 10; i++) {
      t.stdin.write(DOWN);
      await sleep(30);
    }
    await sleep(150);
    // 第 11 项高亮且在窗口内可见（旧实现：渲染截 8 条、高亮索引打到不可见区）；
    // 窗口起点前移 → 视野里应能看到上一个邻居 cmd06
    expect(t.frameWith("❯ /cmd11")).toContain("❯ /cmd11");
    expect(t.frameWith("❯ /cmd11")).toContain("/cmd06");
    t.unmount();
  });

  it("Enter 执行高亮命令（CC/zcode 语义）；Tab 补全不执行", async () => {
    const t = makeHarness();
    await sleep(80);
    t.stdin.write("/compact");
    await sleep(150);
    t.stdin.write("\r");
    await sleep(150);
    expect(t.submits).toEqual(["/compact"]);
    expect(t.value()).toBe("");

    t.stdin.write("/con");
    await sleep(150);
    t.stdin.write("\t"); // Tab 补全到首个候选
    await sleep(150);
    expect(t.submits).toHaveLength(1); // 未新增提交
    expect(t.value()).toMatch(/^\/\w+ $/); // 补全形态：/name + 尾随空格
    t.unmount();
  });

  it("子串匹配：前缀不命中但子串命中（/onte → context）", async () => {
    const t = makeHarness();
    await sleep(80);
    t.stdin.write("/onte");
    await sleep(150);
    expect(t.frameWith("❯ /context")).toContain("context"); // 子串命中且可高亮
    t.unmount();
  });

  it("Esc 关菜单保留输入；继续输入（needle 变化）菜单重开", async () => {
    const t = makeHarness();
    await sleep(80);
    t.stdin.write("/cm");
    await sleep(150);
    expect(t.frameWith("❯ /cmd01")).toContain("cmd01");
    t.stdin.write("\x1b"); // Esc
    await sleep(150);
    expect(t.value()).toBe("/cm"); // 输入保留（旧实现被整段清空）
    // 锚定"含输入行的最新帧"：菜单行应已消失
    const afterEsc = t.frameWith("> /cm");
    expect(afterEsc.includes("❯ /cmd01")).toBe(false);
    // 继续输入：needle 变化 → 菜单重开
    t.stdin.write("d");
    await sleep(150);
    const reopened = t.frameWith("> /cmd");
    expect(reopened.includes("❯ /cmd01")).toBe(true);
    t.unmount();
  });

  it("needle 变化高亮复位到首项", async () => {
    const t = makeHarness();
    await sleep(80);
    t.stdin.write("/");
    await sleep(150);
    t.stdin.write(DOWN);
    t.stdin.write(DOWN);
    await sleep(150);
    expect(t.frameWith("❯ /cmd03")).toContain("cmd03");
    t.stdin.write("c"); // needle: "" → "c"
    await sleep(150);
    expect(t.frameWith("> /c")).toContain("❯ /cmd01"); // 复位首项（cmd01 含 c）
    t.unmount();
  });
});
