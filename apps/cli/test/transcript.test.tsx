import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  TodoPanel,
  Transcript,
  formatToolPreview,
  visualWidth,
  wrapVisual,
} from "../src/tui/Transcript.js";

describe("Transcript 组件（P1-5 TUI）", () => {
  it("渲染用户/工具/助手块与流式文本", () => {
    const { lastFrame } = render(
      <Transcript
        blocks={[
          { kind: "user", text: "受众绑定在哪？" },
          {
            kind: "tool",
            callId: "c1",
            tool: "grep",
            argsPreview: '{"pattern":"受众绑定"}',
            status: "done",
            summary: "src/credentials.ts:1:受众绑定校验",
          },
          {
            kind: "tool",
            callId: "c2",
            tool: "bash",
            argsPreview: '{"command":"npm test"}',
            status: "failed",
            summary: "exit code 1",
          },
          { kind: "assistant", text: "实现在 src/credentials.ts。" },
        ]}
        streamText="流式输出中"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("受众绑定在哪？");
    expect(frame).toContain("✓ grep");
    expect(frame).toContain("src/credentials.ts");
    expect(frame).toContain("✗ bash");
    expect(frame).toContain("实现在 src/credentials.ts。");
    expect(frame).toContain("流式输出中");
  });

  it("TodoPanel 渲染三态任务项", () => {
    const { lastFrame } = render(
      <TodoPanel
        todos={[
          { content: "调研", status: "completed", priority: "high" },
          { content: "写码", status: "in_progress", priority: "medium" },
          { content: "测试", status: "pending", priority: "low" },
        ]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("☑ 调研");
    expect(frame).toContain("◐ 写码");
    expect(frame).toContain("☐ 测试");
  });
});

describe("formatToolPreview 智能参数预览", () => {
  it("bash 显示命令、read 显示路径、grep 显示 pattern@path", () => {
    expect(formatToolPreview("bash", { command: "python --version" })).toBe("python --version");
    expect(formatToolPreview("bash", { command: "a".repeat(80) })).toContain("…");
    expect(formatToolPreview("read", { path: "docs/a.md", offset: 100, limit: 50 })).toBe("docs/a.md:100+50");
    expect(formatToolPreview("grep", { pattern: "防洪", path: "E:/x" })).toBe("防洪 @ E:/x");
    expect(formatToolPreview("write", { path: "out/总结.md", content: "..." })).toBe("out/总结.md");
    expect(formatToolPreview("todo", { todos: [] })).toBe("更新任务清单");
    expect(formatToolPreview("mcp__srv__t", { q: 1 })).toBe(JSON.stringify({ q: 1 }));
  });
});

describe("BlockView 版式（对标主流 CLI）", () => {
  it("banner 渲染版本/模型/cwd；折叠思考只报时长与展开提示", () => {
    const { lastFrame } = render(
      <Transcript
        blocks={[
          { kind: "banner", model: "glm/glm-5.3", cwd: "E:/demo" },
          { kind: "reasoning", text: "内部推演".repeat(20), ms: 5200 },
        ]}
        streamText=""
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("kcode");
    expect(frame).toContain("glm/glm-5.3");
    expect(frame).toContain("E:/demo");
    expect(frame).toContain("✻ 思考 5.2s（Ctrl+O 展开）");
    expect(frame).not.toContain("内部推演");
  });

  it("visualWidth/wrapVisual：CJK 按 2 列折行", () => {
    expect(visualWidth("ab")).toBe(2);
    expect(visualWidth("中")).toBe(2);
    const lines = wrapVisual("a abb 中文中", 6);
    for (const l of lines) {
      expect(visualWidth(l)).toBeLessThanOrEqual(6);
    }
  });
});
