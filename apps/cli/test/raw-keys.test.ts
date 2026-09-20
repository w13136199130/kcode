import { describe, expect, it } from "vitest";
import { parseKeyChunk } from "../src/tui/raw-keys.js";

describe("parseKeyChunk（raw 按键解析）", () => {
  it("方向键：CSI 与 SS3 两种序列都识别", () => {
    expect(parseKeyChunk("\x1b[A")).toEqual([expect.objectContaining({ up: true })]);
    expect(parseKeyChunk("\x1bOA")).toEqual([expect.objectContaining({ up: true })]);
    expect(parseKeyChunk("\x1b[B")).toEqual([expect.objectContaining({ down: true })]);
    expect(parseKeyChunk("\x1bOB")).toEqual([expect.objectContaining({ down: true })]);
  });

  it("回车/Tab/退格/Ctrl+C", () => {
    expect(parseKeyChunk("\r")).toEqual([expect.objectContaining({ enter: true })]);
    expect(parseKeyChunk("\n")).toEqual([expect.objectContaining({ enter: true })]);
    expect(parseKeyChunk("\t")).toEqual([expect.objectContaining({ tab: true })]);
    expect(parseKeyChunk("\x7f")).toEqual([expect.objectContaining({ backspace: true })]);
    expect(parseKeyChunk("\x03")).toEqual([expect.objectContaining({ ctrlC: true })]);
  });

  it("裸 ESC 与双 ESC；普通字符整块跳过；多序列拆分", () => {
    expect(parseKeyChunk("\x1b")).toEqual([expect.objectContaining({ esc: true })]);
    expect(parseKeyChunk("\x1b\x1b")).toEqual([expect.objectContaining({ esc: true })]);
    expect(parseKeyChunk("abc")).toEqual([]);
    const combo = parseKeyChunk("\x1bOA\r");
    expect(combo).toEqual([
      expect.objectContaining({ up: true }),
      expect.objectContaining({ enter: true }),
    ]);
  });
});
