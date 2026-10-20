import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Block } from "@kcode/ui";
import type { SessionHandle } from "../src/session.js";
import { runDispatch, type DispatchContext } from "../src/tui/input/commands.js";

/**
 * 3-28 输入边界（分发层）：
 * - `/Users/...` 等斜杠路径按普通提问发送，不当未知命令吞掉；
 * - 真正的未知 `/命令` 保留原文（回填输入框），不丢输入；
 * - `/remember` 写 AGENTS.md，与 `# ` 快捷方式同源。
 */

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-boundary-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function makeCtx(cwd: string, expand: (name: string, args: string) => Promise<string | null> = async () => null) {
  const runs: string[] = [];
  const blocks: Block[] = [];
  const inputs: string[] = [];
  const history: string[] = [];
  const tasks: { id: string; command: string; status: "running" | "done" | "failed"; exitCode?: number; logPath: string; startedAt: number }[] = [];
  const stopped: string[] = [];
  const session = {
    sessionId: "s1",
    loop: {
      run: async (text: string) => {
        runs.push(text);
        return { sessionId: "s1", turns: 0, toolCalls: 0, status: "completed" as const };
      },
    },
    expandCommand: expand,
    backgroundTasks: () => tasks,
    stopBackgroundTask: (id: string) => {
      stopped.push(id);
      return true;
    },
  } as unknown as SessionHandle;
  const ctx = {
    session,
    sessionRef: { current: session },
    props: { runtime: {}, cwd },
    modelLabel: "test",
    mode: "default",
    inputHistory: { current: [] as string[] },
    suppressNextUserBlock: { current: false },
    pushBlock: (block: Block) => {
      blocks.push(block);
    },
    setInput: (value: string) => {
      inputs.push(value);
    },
    setModelLabel: () => {},
    applyMode: () => {},
    setFullAccessConfirm: () => {},
    setModelPicker: () => {},
    setLoginWizard: () => {},
    setResumePicker: () => {},
    setPermissionsPanel: () => {},
    switchSession: () => {},
    openRewindPicker: () => {},
    openDiffBrowser: () => {},
    runOccupied: async (_session: SessionHandle, _text: string, work: () => Promise<unknown>) => {
      await work();
    },
    saveHistory: (text: string) => {
      history.push(text);
    },
    beginWork: () => {},
    resetAbortSent: () => {},
    exitApp: () => {},
    createSession: async () => session,
    handleEvent: () => {},
    appendDelta: () => {},
    appendReasoning: () => {},
    asker: { confirm: async () => false },
    askUser: { ask: async () => [] },
    onPlanApproval: () => {},
    onQueueChange: () => {},
  } as unknown as DispatchContext;
  return { ctx, runs, blocks, inputs, history, tasks, stopped };
}

describe("斜杠路径按普通提问发送", () => {
  it.each(["/Users/me/project", "/tmp/a.log 里有什么", "//server/share/x", "/.gitignore", "/", "/ 你好"])(
    "%s 不按命令解析，进入模型",
    async (text) => {
      const { ctx, runs, blocks, inputs } = makeCtx(home);
      await runDispatch(ctx, text);
      expect(runs).toEqual([text]);
      expect(blocks.some((b) => b.kind === "info" && b.text.includes("未知命令"))).toBe(false);
      expect(inputs.at(-1)).toBe(""); // 提交后清空
    },
  );

  it("路径提问携带的图片附件正常随行", async () => {
    const { ctx, runs } = makeCtx(home);
    let received: { images?: string[] } | undefined;
    const session = ctx.session as unknown as { loop: { run: (t: string, o?: { images?: string[] }) => Promise<unknown> } };
    session.loop.run = async (text: string, opts) => {
      runs.push(text);
      received = opts;
      return { sessionId: "s1", turns: 0, toolCalls: 0, status: "completed" };
    };
    await runDispatch(ctx, "/tmp/pic.png 图里是什么", ["C:/tmp/a.png"]);
    expect(received).toEqual({ images: ["C:/tmp/a.png"] });
  });
});

describe("未知命令保留原文", () => {
  it("未知 /命令：不执行、原文回填输入框、提示可加空格当提问", async () => {
    const { ctx, runs, blocks, inputs, history } = makeCtx(home);
    await runDispatch(ctx, "/nope 参数");
    expect(runs).toEqual([]);
    expect(history).toEqual([]);
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("未知命令 /nope"))).toBe(true);
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("原文已保留"))).toBe(true);
    expect(inputs.at(-1)).toBe("/nope 参数"); // 末次回填，不是空
  });

  it("自定义命令仍走 expandCommand（回归：路径判定不误伤合法命令名）", async () => {
    const { ctx, runs, blocks, history } = makeCtx(home, async (name, args) => `EXPANDED ${name} ${args}`);
    await runDispatch(ctx, "/review src/auth.ts");
    expect(runs).toEqual(["EXPANDED review src/auth.ts"]);
    expect(history).toEqual(["/review src/auth.ts"]);
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("未知命令"))).toBe(false);
  });
});

describe("/remember（# 的显式同义命令）", () => {
  it("写入项目 AGENTS.md，不进模型", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcode-remember-"));
    const { ctx, runs, blocks } = makeCtx(dir);
    await runDispatch(ctx, "/remember 构建统一用 pnpm");
    expect(runs).toEqual([]);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("构建统一用 pnpm\n");
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("📝 已记入"))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("空参数只给用法，不创建文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcode-remember-empty-"));
    const { ctx, blocks } = makeCtx(dir);
    await runDispatch(ctx, "/remember");
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("用法：/remember"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("/tasks（3-27 后台任务可见性）", () => {
  it("列出 id/状态/日志路径与面板入口", async () => {
    const { ctx, blocks, tasks } = makeCtx(home);
    tasks.push(
      { id: "bg_1", command: "npm run build", status: "running", logPath: "C:/logs/bg_1.log", startedAt: 1 },
      { id: "bg_2", command: "echo hi", status: "failed", exitCode: 1, logPath: "C:/logs/bg_2.log", startedAt: 2 },
    );
    await runDispatch(ctx, "/tasks");
    const info = blocks.filter((b) => b.kind === "info").map((b) => (b.kind === "info" ? b.text : "")).join("\n");
    expect(info).toContain("2 个 · 1 运行");
    expect(info).toContain("bg_1");
    expect(info).toContain("npm run build");
    expect(info).toContain("bg_2");
    expect(info).toContain("exit 1");
    expect(info).toContain("C:/logs/bg_1.log");
    expect(info).toContain("/tasks stop");
  });

  it("空清单给可行动提示", async () => {
    const { ctx, blocks } = makeCtx(home);
    await runDispatch(ctx, "/tasks");
    const info = blocks.find((b) => b.kind === "info");
    expect(info?.kind === "info" ? info.text : "").toContain("暂无后台任务");
  });

  it("/tasks stop <id> 终止并回显；缺 id 给用法", async () => {
    const { ctx, blocks, stopped } = makeCtx(home);
    await runDispatch(ctx, "/tasks stop bg_9");
    expect(stopped).toEqual(["bg_9"]);
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("已停止后台任务 bg_9"))).toBe(true);

    await runDispatch(ctx, "/tasks stop");
    expect(blocks.some((b) => b.kind === "info" && b.text.includes("用法：/tasks stop"))).toBe(true);
  });
});
