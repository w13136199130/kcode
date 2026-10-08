import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import { completePath } from "../src/tui/input/file-complete.js";
import { InputBox } from "../src/tui/input/InputBox.js";
import type { CommandInfo } from "../src/tui/input/builtin-commands.js";

/** N3G-1：Tab 路径/命令参数补全——三态判定、菜单交互、参数提示展示不插入 */

describe("completePath（路径形态补全）", () => {
  const files = ["a/x.ts", "a/y.md", "a/sub/w.ts", "b/z.ts", "root.txt"];

  it("前缀匹配；反斜杠归一；./ 前缀剥离；大小写不敏感；子串不算命中", () => {
    expect(completePath(files, "a/")).toEqual(["a/x.ts", "a/y.md", "a/sub/w.ts"]);
    expect(completePath(files, "A/X")).toEqual(["a/x.ts"]);
    expect(completePath(files, "a\\")).toEqual(["a/x.ts", "a/y.md", "a/sub/w.ts"]);
    expect(completePath(files, "./root")).toEqual(["root.txt"]);
    expect(completePath(files, "x.ts")).toEqual([]); // 子串非前缀：补全语义下不命中
    expect(completePath(files, "")).toEqual([]);
  });
});

const COMMANDS: CommandInfo[] = [
  { name: "mode", desc: "切换模式", argsHint: "[plan | default | acceptEdits | fullAccess]" },
  { name: "noargs", desc: "无参数命令" },
];

function Harness(props: { report: (v: string) => void; cwd: string }): ReactElement {
  const [value, setValue] = useState("");
  useEffect(() => {
    props.report(value);
  }, [value, props.report]);
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      history={[]}
      commands={COMMANDS}
      cwd={props.cwd}
    />
  );
}

function makeHarness(cwd: string) {
  const frames: string[] = [];
  const values: string[] = [];
  const stdout = {
    write(s: string) {
      frames.push(s);
      return true;
    },
    columns: 100,
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
  const instance = render(<Harness report={report} cwd={cwd} />, {
    stdout: stdout as never,
    stdin: stdin as never,
  });
  return {
    stdin,
    values,
    value: () => values.at(-1) ?? "",
    frameWith: (sub: string): string => [...frames].reverse().find((f) => f.includes(sub)) ?? "",
    unmount: () => instance.unmount(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kcode-tab-"));
  await mkdir(join(dir, "a", "sub"), { recursive: true });
  await mkdir(join(dir, "b"), { recursive: true });
  await writeFile(join(dir, "a", "x.ts"), "x", "utf8");
  await writeFile(join(dir, "a", "y.md"), "y", "utf8");
  await writeFile(join(dir, "a", "sub", "w.ts"), "w", "utf8");
  await writeFile(join(dir, "b", "z.ts"), "z", "utf8");
  await writeFile(join(dir, "root.txt"), "r", "utf8");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("InputBox Tab 补全", () => {
  it("路径形态：Tab 开菜单（↑↓ 可选）→ Tab 插入候选 + 尾随空格", async () => {
    const t = makeHarness(dir);
    await sleep(80);
    t.stdin.write("a/x");
    await sleep(60);
    t.stdin.write("\t");
    await sleep(250); // listProjectFiles 首次列举
    const menu = t.frameWith("❯ a/x.ts");
    expect(menu).toContain("a/x.ts");
    t.stdin.write("\t"); // 选中插入
    await sleep(150);
    expect(t.value()).toBe("a/x.ts ");
    t.unmount();
  });

  it("./ 前缀与目录候选；非路径词 Tab 无菜单无副作用", async () => {
    const t = makeHarness(dir);
    await sleep(80);
    t.stdin.write("./roo");
    await sleep(60);
    t.stdin.write("\t");
    await sleep(250);
    expect(t.frameWith("root.txt")).toContain("root.txt");
    t.stdin.write("\t");
    await sleep(150);
    expect(t.value()).toBe("root.txt ");

    // 非路径 token：Tab 不做事（三态都不命中）
    t.stdin.write("hello");
    await sleep(60);
    const before = t.value();
    t.stdin.write("\t");
    await sleep(150);
    expect(t.value()).toBe(before);
    t.unmount();
  });

  it("命令参数位提示：展示不插入；未知命令无提示", async () => {
    const t = makeHarness(dir);
    await sleep(80);
    t.stdin.write("/mode ");
    await sleep(200);
    expect(t.frameWith("参数：")).toContain("[plan | default | acceptEdits | fullAccess]");
    expect(t.value()).toBe("/mode "); // 展示不插入
    // 继续输入仍显示
    t.stdin.write("plan");
    await sleep(150);
    expect(t.frameWith("/mode plan")).toContain("参数：");
    // 未知命令无提示
    t.stdin.write("\x7f\x7f\x7f\x7f"); // 退回 "/mode "
    await sleep(150);
    t.stdin.write("\x7f"); // 退回 "/mode"（无空格：命令名补全域）
    await sleep(150);
    expect(t.frameWith("/zzz")).toBe(""); // 从未有未知命令提示（此查询不应有帧）
    t.unmount();
  });

  it("@ 优先：@token 走既有文件引用菜单（插入为裸路径+空格——B4 既有契约，@ 只是触发符）", async () => {
    const t = makeHarness(dir);
    await sleep(80);
    t.stdin.write("@a/y");
    await sleep(250);
    const menu = t.frameWith("❯ @a/y.md");
    expect(menu).toContain("@a/y.md");
    t.stdin.write("\t");
    await sleep(150);
    expect(t.value()).toBe("a/y.md ");
    t.unmount();
  });
});
