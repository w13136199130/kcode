import { describe, expect, it } from "vitest";
import type { Block } from "@kcode/ui";
import { blocksToMarkdown } from "../src/tui/export.js";

/** N3I-6 会话导出：转写块 → Markdown 纯函数 */

describe("blocksToMarkdown", () => {
  it("用户/助手成节；banner 转元信息行；info 带语气图标", () => {
    const md = blocksToMarkdown([
      { kind: "banner", model: "deepseek/chat", cwd: "E:\\proj" },
      { kind: "user", text: "看一下这个项目" },
      { kind: "assistant", text: "好的，先看目录。" },
      { kind: "info", text: "已切换", tone: "ok" },
      { kind: "info", text: "已拒绝", tone: "deny" },
    ]);
    expect(md).toContain("# kcode 会话导出");
    expect(md).toContain("> deepseek/chat · E:\\proj");
    expect(md).toContain("## 🧑 用户\n\n看一下这个项目");
    expect(md).toContain("## 🤖 助手\n\n好的，先看目录。");
    expect(md).toContain("> ✓ 已切换");
    expect(md).toContain("> ✗ 已拒绝");
  });

  it("工具块：状态图标 + 摘要 + 输出截断 200 字符", () => {
    const md = blocksToMarkdown([
      {
        kind: "tool",
        callId: "c1",
        tool: "bash",
        argsPreview: "npm test",
        status: "done",
        summary: "exit 0 · 3s",
        output: "x".repeat(500),
      },
      { kind: "tool", callId: "c2", tool: "write", argsPreview: "a.ts", status: "failed" },
    ]);
    expect(md).toContain("> 🔧 `bash` npm test ✓ exit 0 · 3s");
    expect(md).not.toContain("x".repeat(300)); // 输出已截断
    expect(md).toContain("> 🔧 `write` a.ts ✗");
  });

  it("思考块取首行截断；空块列表只有标题", () => {
    const md = blocksToMarkdown([
      { kind: "reasoning", text: "第一行思考\n第二行不该出现", ms: 1200 },
    ]);
    expect(md).toContain("💭 第一行思考");
    expect(md).not.toContain("第二行");
    expect(blocksToMarkdown([])).toBe("# kcode 会话导出\n\n");
  });
});
