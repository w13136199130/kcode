import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackgroundTaskRegistry, createBashTool, createTaskTools } from "../src/index.js";

/**
 * 后台任务控制工具对（task_output / task_stop）：真实 bash 后台任务 + 注入注册表，
 * 验证"启动 → 查输出 → 终止 → 终态回看"全链路与幂等/未知 id 边界。
 */

let root: string;
const ctx = (): { sessionId: string; cwd: string } => ({ sessionId: "s", cwd: root });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-task-tools-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("task_output / task_stop（后台任务显式控制）", () => {
  it("启动 → task_output 看到日志尾部与运行态 → task_stop 终止 → 终态可回看", async () => {
    const registry = new BackgroundTaskRegistry();
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art"), registry });
    const [taskOutput, taskStop] = createTaskTools(registry);

    const started = await bash.execute({ command: "echo task-line-1; sleep 30", runInBackground: true }, ctx());
    expect(started.ok).toBe(true);
    const id = (started.output.match(/bg_[a-z0-9-]+/) ?? [])[0] ?? "";
    expect(id).not.toBe("");

    // 日志行落盘是异步的：轮询 task_output 直到首行出现（顺带覆盖"运行中"状态视图）
    let output = "";
    for (let i = 0; i < 40; i++) {
      const r = await taskOutput.execute({ taskId: id }, ctx());
      output = r.output;
      if (output.includes("task-line-1")) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(output).toContain("task-line-1");
    expect(output).toContain("运行中");

    const stopped = await taskStop.execute({ taskId: id }, ctx());
    expect(stopped.ok).toBe(true);
    expect(stopped.output).toContain("终止信号");
    await waitFor(() => registry.get(id)?.status !== "running");
    const final = await taskOutput.execute({ taskId: id }, ctx());
    expect(final.output).toContain("失败");
  }, 20_000);

  it("权限声明：task_output 只读放行，task_stop 默认询问且 plan 档拒绝（非只读自动推导）", () => {
    const [taskOutput, taskStop] = createTaskTools(new BackgroundTaskRegistry());
    expect(taskOutput.definition.readOnly).toBe(true);
    expect(taskOutput.definition.permission).toEqual({ default: "allow" });
    expect(taskStop.definition.readOnly).toBe(false);
    expect(taskStop.definition.permission).toEqual({ default: "ask" });
  });

  it("未知任务报错；已完成任务再 stop 返回说明而非报错（幂等）", async () => {
    const registry = new BackgroundTaskRegistry();
    const [taskOutput, taskStop] = createTaskTools(registry);
    const bash = createBashTool({ sessionId: "s", artifactsDir: join(root, "art2"), registry });

    const unknown = await taskOutput.execute({ taskId: "bg_none" }, ctx());
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("未知任务");

    const started = await bash.execute({ command: "echo quick", runInBackground: true }, ctx());
    const id = (started.output.match(/bg_[a-z0-9-]+/) ?? [])[0] ?? "";
    await waitFor(() => registry.get(id)?.status === "done");
    const noop = await taskStop.execute({ taskId: id }, ctx());
    expect(noop.ok).toBe(true);
    expect(noop.output).toContain("已结束");
  }, 20_000);
});
