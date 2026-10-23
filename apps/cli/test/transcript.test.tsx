import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  TodoPanel,
  Transcript,
  formatToolPreview,
  visualWidth,
  wrapVisual,
} from "../src/tui/transcript/Transcript.js";

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

  it("完成的工具卡显示首行 + 共 N 行 + Ctrl+B 入口", () => {
    const { lastFrame } = render(
      <Transcript
        blocks={[
          {
            kind: "tool",
            callId: "c1",
            tool: "bash",
            argsPreview: "ls -1 apps/",
            status: "done",
            summary: "cli",
            output: "cli\ndesktop\nhost\nmarket\nweb",
          },
        ]}
        streamText=""
      />,
    );
    expect(lastFrame() ?? "").toContain("cli · 共 5 行 · Ctrl+B 查看全部");
  });

  it("长回答默认折叠前 30 行，Ctrl+O 展开全文", () => {
    const long = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    const blocks = [{ kind: "assistant" as const, text: long }];
    const { lastFrame, rerender } = render(<Transcript blocks={blocks} streamText="" />);
    const folded = lastFrame() ?? "";
    expect(folded).toContain("第 30 行");
    expect(folded).not.toContain("第 31 行");
    expect(folded).toContain("共 50 行");
    expect(folded).toContain("Ctrl+O 展开当前轮");

    rerender(<Transcript blocks={blocks} streamText="" verbose />);
    const expanded = lastFrame() ?? "";
    expect(expanded).toContain("第 50 行");
    expect(expanded).not.toContain("共 50 行");
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
    expect(frame).toContain("Thought for 5.2s (ctrl+o to expand)");
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

  it("3-22 失败工具的 verbose 输出默认显示末尾（错误集中在尾部）", () => {
    const output = ["HEAD", ...Array.from({ length: 20 }, (_, i) => `middle${i + 1}`), "TAIL"].join("\n");
    const { lastFrame } = render(
      <Transcript
        blocks={[{ kind: "tool", callId: "c1", tool: "bash", argsPreview: "npm test", status: "failed", output }]}
        streamText=""
        verbose
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("TAIL");
    expect(frame).not.toContain("HEAD");
    expect(frame).toContain("仅显示末尾 12 行 · Ctrl+O 展开 / Ctrl+B 查看全部");
  });

  it("3-26：工具/助手/用户文本里的 OSC/CSI 不会出现在渲染帧", () => {
    const evil = "开始\u001b]0;pwned\u0007中\u001b[2J结束";
    const { lastFrame } = render(
      <Transcript
        blocks={[
          { kind: "user", text: evil },
          { kind: "tool", callId: "c1", tool: "bash", argsPreview: evil, status: "done", summary: evil, output: evil },
          { kind: "assistant", text: evil },
        ]}
        streamText=""
        verbose
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("结束");
    expect(frame).not.toContain("pwned");
  });
});
