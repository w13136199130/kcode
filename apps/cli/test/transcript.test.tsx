import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Transcript } from "../src/tui/Transcript.js";

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
});
