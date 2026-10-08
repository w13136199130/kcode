import { describe, expect, it } from "vitest";
import { writeTerminalTitle } from "../src/tui/terminal/title.js";
import { BELL_MIN_BUSY_MS, bellOnEdge, ringBell } from "../src/tui/terminal/notify.js";
import { SUBAGENT_NOTIFICATION_HEADER, isBackgroundCompletionNotice } from "@kcode/session";

/** 假 sink：记录写入并可控 isTTY */
function fakeSink(isTTY = true) {
  const written: string[] = [];
  return { sink: { write: (s: string) => void written.push(s), isTTY }, written };
}

/** N3F-2/3：标题栏与完成铃的门控、序列形态、沿判定纯函数 */
describe("N3F-2 终端标题栏", () => {
  it("OSC 0 序列 + BEL 终止符；门控：非 TTY 不写、KCODE_TITLE=0 关", () => {
    const { sink, written } = fakeSink();
    writeTerminalTitle("kcode ⏳ 处理工具：bash", sink);
    expect(written).toEqual([`\x1b]0;kcode ⏳ 处理工具：bash\x07`]);

    const pipe = fakeSink(false);
    writeTerminalTitle("x", pipe.sink);
    expect(pipe.written).toEqual([]);

    const off = fakeSink();
    writeTerminalTitle("x", off.sink, { KCODE_TITLE: "0" });
    expect(off.written).toEqual([]);
  });
});

describe("N3F-3 完成铃", () => {
  it("写单个 BEL；门控：非 TTY 不写、KCODE_BELL=0 关", () => {
    const { sink, written } = fakeSink();
    ringBell(sink);
    expect(written).toEqual(["\a"]);

    const pipe = fakeSink(false);
    ringBell(pipe.sink);
    expect(pipe.written).toEqual([]);

    const off = fakeSink();
    ringBell(off.sink, { KCODE_BELL: "0" });
    expect(off.written).toEqual([]);
  });

  it("沿判定：忙→闲且本轮 ≥10s 才响；短轮/上升沿/闲→闲不响", () => {
    const t0 = 1_000_000;
    expect(bellOnEdge(true, false, t0, t0 + BELL_MIN_BUSY_MS)).toBe(true);
    expect(bellOnEdge(true, false, t0, t0 + BELL_MIN_BUSY_MS - 1)).toBe(false);
    expect(bellOnEdge(false, false, t0, t0 + BELL_MIN_BUSY_MS)).toBe(false);
    expect(bellOnEdge(true, true, t0, t0 + BELL_MIN_BUSY_MS)).toBe(false);
    expect(bellOnEdge(true, false, null, t0 + BELL_MIN_BUSY_MS)).toBe(false);
  });

  it("后台完成通知判定：完成头命中，respond 中间消息不命中（N3F-4 同头）", () => {
    const completion = `${SUBAGENT_NOTIFICATION_HEADER}\n后台子代理完成：general「x」（sub_1，1 轮）\n结论：\nok`;
    const respond = `${SUBAGENT_NOTIFICATION_HEADER}\n<subagent-message>\n<agent-id>sub_1</agent-id>\n</subagent-message>`;
    expect(isBackgroundCompletionNotice(completion)).toBe(true);
    expect(isBackgroundCompletionNotice(respond)).toBe(false);
  });
});
