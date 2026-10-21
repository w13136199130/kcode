import { describe, expect, it } from "vitest";
import type { Block } from "@kcode/ui";
import { lastAssistantText, lastCodeBlock, lastCodeBlockOf } from "../src/tui/input/copy.js";

const assistant = (text: string): Block => ({ kind: "assistant", text });

/** 3-34：/copy 目标提取（最近回复 / 最近代码块；跳过非 assistant 块） */
describe("copy 目标提取", () => {
  it("lastAssistantText 取最近非空回复并剥离控制序列", () => {
    const blocks: Block[] = [
      assistant("旧回复"),
      { kind: "tool", callId: "c", tool: "read", argsPreview: "", status: "done" },
      assistant("新回复\x1b[31m红色\x1b[0m"),
    ];
    expect(lastAssistantText(blocks)).toBe("新回复红色");
  });

  it("lastCodeBlock 跳过无代码回复，向前找最后一个代码块", () => {
    const blocks: Block[] = [assistant("```ts\nconst a = 1;\n```"), assistant("没有代码")];
    expect(lastCodeBlock(blocks)).toEqual({ lang: "ts", code: "const a = 1;\n" });
  });

  it("lastCodeBlockOf 取多个围栏中的最后一个；未闭合不算", () => {
    expect(lastCodeBlockOf("```js\na\n```\n中间\n```py\nb\n```")?.code).toBe("b\n");
    expect(lastCodeBlockOf("```js\n未闭合")).toBeNull();
  });

  it("没有 assistant / 没有代码块返回 null", () => {
    expect(lastAssistantText([])).toBeNull();
    expect(lastCodeBlock([assistant("纯文本")])).toBeNull();
  });
});
