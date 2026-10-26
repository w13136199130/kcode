import { describe, expect, it } from "vitest";
import { describeCreateError, errText, switchBlockedReason } from "../src/renderer/lib/switch-guards.js";

describe("创建/切换守卫（P0-2/P0-3）", () => {
  it("lease 拒绝映射为可行动文案", () => {
    const hostError = new Error("会话正被另一宿主持有（pid 4242 存活）——拒绝接管，防双活写回（注 B）");
    expect(describeCreateError(hostError)).toBe("该任务正在其他窗口使用中——先在那边结束，或稍后重试");
  });

  it("其他错误保留原文案，不吞信息", () => {
    expect(describeCreateError(new Error("KCODE_FAULT: session/create 注入失败"))).toContain("注入失败");
    expect(describeCreateError("字符串错误")).toBe("字符串错误");
    expect(errText(new Error("x"))).toBe("x");
  });

  it("busy 拦截文案覆盖三类动作且语义一致", () => {
    expect(switchBlockedReason("new")).toBe("运行中不能新建会话（先停止或等待本轮完成）");
    expect(switchBlockedReason("switch")).toBe("运行中不能切换任务（先停止或等待本轮完成）");
    expect(switchBlockedReason("workspace")).toBe("运行中不能切换工作区（先停止或等待本轮完成）");
  });
});
