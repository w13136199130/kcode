import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "ink-testing-library";
import { render as renderInk } from "ink";
import { createUiStore } from "@kcode/ui";
import { HistorySearch } from "../src/tui/input/HistorySearch.js";
import { InputArea } from "../src/tui/input/InputArea.js";
import { BlockView } from "../src/tui/transcript/Transcript.js";
import { readClipboardImageToFile } from "../src/tui/input/clipboard-image.js";
import { FakeTtyStdin } from "./helpers/fake-tty.js";

/**
 * N3C-4⑤⑥⑦ 测试：图片附件（pendingImages + Ctrl+V + 提交随行）、历史搜索覆盖层、
 * 欢迎横幅键位提示。Ctrl+V 的剪贴板读取经 vi.mock 固定返回（OS 交互单测见末尾 describe）。
 */

vi.mock("../src/tui/input/clipboard-image.js", () => ({
  readClipboardImageToFile: vi.fn(async () => "C:/tmp/kcode-paste-fake.png"),
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function mountProbe(element: JSX.Element): { stdin: FakeTtyStdin; frame(): string; frameWith(sub: string): string; settle(ms?: number): Promise<void> } {
  const stdin = new FakeTtyStdin();
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 120,
    rows: 40,
    isTTY: true,
    write: (text: string) => {
      frames.push(text);
      return true;
    },
  });
  const instance = renderInk(element, {
    stdin: stdin as unknown as typeof process.stdin,
    stdout: stdout as unknown as typeof process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanups.push(() => {
    instance.unmount();
    stdin.destroy();
  });
  return {
    stdin,
    frame: () => frames.at(-1) ?? "",
    /** 从后往前找含某子串的帧（末次 write 可能是光标控制序列而非整帧） */
    frameWith: (sub: string): string => [...frames].reverse().find((f) => f.includes(sub)) ?? "",
    settle: (ms = 120) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** InputArea 挂载组件：受控输入需要真实回写（useState）才能打字提交；提交后清空对齐 App 行为 */
function InputAreaHarness(props: {
  ui: ReturnType<typeof createUiStore>;
  onSubmit(v: string, images?: string[]): void;
  history: string[];
  /** # 记忆等落盘行为的根目录（默认 .；测试传临时目录） */
  cwd?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <InputArea
      ui={props.ui}
      ready={true}
      interactive={true}
      value={value}
      onChange={setValue}
      onSubmit={(v, images) => {
        props.onSubmit(v, images);
        setValue("");
      }}
      history={props.history}
      commands={[]}
      cwd={props.cwd ?? "."}
      onCjkCommit={() => {}}
    />
  );
}

function mountInputArea(store: ReturnType<typeof createUiStore>, onSubmit: (v: string, images?: string[]) => void) {
  return mountProbe(
    <InputAreaHarness
      ui={store}
      onSubmit={onSubmit}
      history={["修一下登录报错", "解释 grep 的用法", "再跑一次测试"]}
    />,
  );
}

describe("slice：图片附件与历史搜索状态", () => {
  it("pendingImages 增删清；resetTranscript 一并复位", () => {
    const store = createUiStore();
    store.getState().addPendingImage("a.png");
    store.getState().addPendingImage("a.png"); // 去重
    store.getState().addPendingImage("b.png");
    expect(store.getState().pendingImages).toEqual(["a.png", "b.png"]);
    store.getState().removePendingImage("a.png");
    expect(store.getState().pendingImages).toEqual(["b.png"]);
    store.getState().openHistorySearch();
    expect(store.getState().historySearchOpen).toBe(true);
    store.getState().resetTranscript();
    expect(store.getState().pendingImages).toEqual([]);
    expect(store.getState().historySearchOpen).toBe(false);
  });
});

describe("⑤ Ctrl+V 贴图与提交随行", () => {
  it("Ctrl+V 加入附件并提示；空闲提交携带 images；排队提交不带", async () => {
    const store = createUiStore();
    const submits: Array<[string, string[] | undefined]> = [];
    const { stdin, settle } = mountInputArea(store, (v, images) => submits.push([v, images]));

    stdin.write("\x16"); // Ctrl+V → mock 剪贴板返回固定路径
    await settle(200);
    expect(store.getState().pendingImages).toEqual(["C:/tmp/kcode-paste-fake.png"]);
    expect(store.getState().blocks.some((b) => b.kind === "info" && b.text.includes("已附加剪贴板图片"))).toBe(true);

    // 空闲提交：附件随行（清空职责在 App.submit 守卫之后，InputArea 只透传——不在此断言）
    stdin.write("看看这张图");
    await settle();
    stdin.write("\r");
    await settle(200);
    expect(submits.at(-1)).toEqual(["看看这张图", ["C:/tmp/kcode-paste-fake.png"]]);

    // 排队提交（busy）：不带附件，附件保留
    store.getState().addPendingImage("c.png");
    store.getState().begin();
    stdin.write("排队消息");
    await settle();
    stdin.write("\r");
    await settle(200);
    expect(submits.at(-1)).toEqual(["排队消息", undefined]);
    // 排队不消费附件；第一张也未清（清空职责在真实 App.submit，本挂载不含）
    expect(store.getState().pendingImages).toEqual(["C:/tmp/kcode-paste-fake.png", "c.png"]);
  }, 10_000);
});

describe("⑥ 历史搜索覆盖层", () => {
  it("Ctrl+R 打开 → 输入关键词过滤 → Enter 回填并关闭；Esc 直接关闭", async () => {
    const store = createUiStore();
    const picked: string[] = [];
    // InputArea 是 HistorySearch 的宿主：open 后由它渲染覆盖层并接住键位
    const { stdin, frame, settle } = mountInputAreaWith(store, (t) => picked.push(t), [
      "修一下登录报错",
      "解释 grep 的用法",
      "再跑一次测试",
    ]);

    stdin.write("\x12"); // Ctrl+R
    await settle(200);
    expect(store.getState().historySearchOpen).toBe(true);
    expect(frame()).toContain("匹配 3 条");

    stdin.write("grep");
    await settle(200);
    expect(frame()).toContain("❯ 解释 grep 的用法");
    expect(frame()).not.toContain("修一下登录报错");

    stdin.write("\r"); // Enter 回填
    await settle(200);
    expect(picked).toEqual(["解释 grep 的用法"]);
    expect(store.getState().historySearchOpen).toBe(false);

    // 再开一次用 Esc 关闭（不回填）
    stdin.write("\x12");
    await settle(200);
    stdin.write("\x1b");
    await settle(200);
    expect(store.getState().historySearchOpen).toBe(false);
    expect(picked).toHaveLength(1);
  }, 15_000);
});

/** InputArea 挂载（带可注入历史，供 ⑥ 用例） */
function mountInputAreaWith(
  store: ReturnType<typeof createUiStore>,
  onPick: (text: string) => void,
  history: string[],
) {
  return mountProbe(
    <InputArea
      ui={store}
      ready={true}
      interactive={true}
      value=""
      onChange={onPick}
      onSubmit={() => {}}
      history={history}
      commands={[]}
      cwd="."
      onCjkCommit={() => {}}
    />,
  );
}

describe("⑦ 欢迎横幅键位提示", () => {
  it("横幅键位教学收敛为一行指路（Ctrl 系键位改由 /help 承载）", () => {
    const { lastFrame } = render(<BlockView block={{ kind: "banner", model: "m", cwd: "." }} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("输入 / 命令菜单");
    expect(frame).toContain("/help 全部键位");
    // 两行 Ctrl 键位清单已删除（截屏反馈：banner 密度过高）
    expect(frame).not.toContain("Ctrl+O 展开思考");
    expect(frame).not.toContain("Ctrl+E 编辑器");
  });
});

describe("剪贴板读图（仅 Windows 实跑；无剪贴板服务环境自动跳过）", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "kcode-clip-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it.runIf(process.platform === "win32")("剪贴板放置位图后能读出 PNG 文件", async () => {
    // 文件顶部 vi.mock 了剪贴板模块（Ctrl+V 链路测试用），本用例取真实现
    const actual = await vi.importActual<typeof import("../src/tui/input/clipboard-image.js")>(
      "../src/tui/input/clipboard-image.js",
    );
    // 先往剪贴板放一张 2x2 位图（与被测实现同一套 WinForms 通道）
    const setOk = await new Promise<boolean>((resolve) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
            "$bmp = New-Object System.Drawing.Bitmap(2,2); [System.Windows.Forms.Clipboard]::SetImage($bmp); exit 0",
        ],
        { windowsHide: true },
      );
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!setOk) {
      return; // CI/无桌面会话：剪贴板服务不可用，跳过（函数已有 null 降级路径）
    }
    const path = await actual.readClipboardImageToFile(join(home, "tmp"));
    expect(path).not.toBeNull();
    const magic = await readFile(path!);
    expect(magic.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG 魔数
  }, 20_000);

  it("非 Windows 返回 null（走 --image 提示降级）", async () => {
    if (process.platform === "win32") {
      return;
    }
    expect(await readClipboardImageToFile(join(home, "tmp"))).toBeNull();
  });
});

describe("N3G-3 # 快捷记忆", () => {
  it("# 开头：不进模型不进历史，写 AGENTS.md 并清空输入；📝 通知", async () => {
    const home = await mkdtemp(join(tmpdir(), "kcode-hashmem-"));
    const store = createUiStore();
    const submits: string[] = [];
    const { stdin, settle } = mountProbe(
      <InputAreaHarness ui={store} onSubmit={(v) => submits.push(v)} history={[]} cwd={home} />,
    );
    stdin.write("# 构建统一用 pnpm");
    await settle();
    stdin.write("\r");
    await settle(250);
    expect(submits).toEqual([]); // 不进模型
    expect(await readFile(join(home, "AGENTS.md"), "utf8")).toBe("构建统一用 pnpm\n");
    expect(store.getState().blocks.some((b) => b.kind === "info" && b.text.includes("📝 已记入"))).toBe(true);
    // 输入已清空（后续再输入正常）
    stdin.write("正常提问");
    await settle();
    stdin.write("\r");
    await settle(200);
    expect(submits.at(-1)).toBe("正常提问");
    await rm(home, { recursive: true, force: true });
  });

  it("裸 # ：提示无内容，不写文件不提交", async () => {
    const home = await mkdtemp(join(tmpdir(), "kcode-hashmem2-"));
    const store = createUiStore();
    const submits: string[] = [];
    const { stdin, settle } = mountProbe(
      <InputAreaHarness ui={store} onSubmit={(v) => submits.push(v)} history={[]} cwd={home} />,
    );
    stdin.write("#");
    await settle();
    stdin.write("\r");
    await settle(200);
    expect(submits).toEqual([]);
    expect(store.getState().blocks.some((b) => b.kind === "info" && b.text.includes("没有要记住的内容"))).toBe(true);
    await rm(home, { recursive: true, force: true });
  });
});

describe("N3G-4 ghost 提示（空态建议条已按截图反馈移除）", () => {
  it("空态只渲染 ghost；数字键是普通字符（无建议填入）；ghost 输入即让位", async () => {
    const store = createUiStore();
    const submits: string[] = [];
    const { stdin, frameWith, settle } = mountInputArea(store, (v) => submits.push(v));
    await settle(250);
    expect(frameWith("# 记住偏好")).toContain("# 记住偏好"); // ghost
    expect(frameWith("# 记住偏好")).not.toContain("①"); // 建议条不再渲染

    stdin.write("1"); // 数字键直接输入（曾有数字快捷填入建议）
    await settle(250);
    expect(submits).toEqual([]);
    const f1 = frameWith("> 1");
    expect(f1.includes("# 记住偏好")).toBe(false); // ghost 让位

    stdin.write("\r");
    await settle(200);
    expect(submits.at(-1)).toBe("1");
  });

  it("转写出现内容块后空输入仍有 ghost", async () => {
    const store = createUiStore();
    store.getState().pushBlock({ kind: "user", text: "hi" });
    const { frameWith, settle } = mountInputArea(store, () => {});
    await settle();
    // 末帧可能是控制序列（如隐藏光标）：锚定含 ghost 的帧反向搜索
    expect(frameWith("# 记住偏好")).toContain("# 记住偏好");
  });
});
