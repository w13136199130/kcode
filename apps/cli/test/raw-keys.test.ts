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

  it("Home/End/Delete：CSI/SS3/tilde 三种形态", () => {
    expect(parseKeyChunk("[H")).toEqual([expect.objectContaining({ home: true })]);
    expect(parseKeyChunk("OH")).toEqual([expect.objectContaining({ home: true })]);
    expect(parseKeyChunk("[1~")).toEqual([expect.objectContaining({ home: true })]);
    expect(parseKeyChunk("[F")).toEqual([expect.objectContaining({ end: true })]);
    expect(parseKeyChunk("OF")).toEqual([expect.objectContaining({ end: true })]);
    expect(parseKeyChunk("[4~")).toEqual([expect.objectContaining({ end: true })]);
    expect(parseKeyChunk("[3~")).toEqual([expect.objectContaining({ delete: true })]);
  });

  it("裸 ESC 与双 ESC；多序列拆分", () => {
    expect(parseKeyChunk("\x1b")).toEqual([expect.objectContaining({ esc: true })]);
    expect(parseKeyChunk("\x1b\x1b")).toEqual([expect.objectContaining({ esc: true })]);
    expect(parseKeyChunk("abc")).toEqual([expect.objectContaining({ text: "abc" })]);
    const combo = parseKeyChunk("\x1bOA\r");
    expect(combo).toEqual([
      expect.objectContaining({ up: true }),
      expect.objectContaining({ enter: true }),
    ]);
  });
});

describe("parseKeyChunk text 事件（字符输入走 raw 层）", () => {
  it("连续可打印串一段；混合块按序拆分", () => {
    expect(parseKeyChunk("abc")).toEqual([expect.objectContaining({ text: "abc" })]);
    expect(parseKeyChunk("你a")).toEqual([expect.objectContaining({ text: "你a" })]);
    expect(parseKeyChunk("hi[Dj")).toEqual([
      expect.objectContaining({ text: "hi" }),
      expect.objectContaining({ left: true }),
      expect.objectContaining({ text: "j" }),
    ]);
  });
});
