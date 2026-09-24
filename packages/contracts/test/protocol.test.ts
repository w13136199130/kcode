import { describe, expect, it } from "vitest";
import {
  PROTOCOL_MAJOR,
  ProtocolHello,
  CommandEnvelope,
  EventCursor,
  assertCompatibleHello,
} from "../src/protocol.js";

describe("跨进程协议契约", () => {
  it("握手 schema 校验主/次版本与能力；改一处字段形状即失败", () => {
    const hello = ProtocolHello.parse({ major: 1, minor: 0, capabilities: ["stdio", "resume"] });
    expect(hello.capabilities).toEqual(["stdio", "resume"]);
    // 缺 capabilities / major 类型错，运行时校验都应失败
    expect(ProtocolHello.safeParse({ major: 1, minor: 0 }).success).toBe(false);
    expect(ProtocolHello.safeParse({ major: "1", minor: 0, capabilities: [] }).success).toBe(false);
  });

  it("主版本不一致拒绝连接并给出可操作提示", () => {
    expect(() => assertCompatibleHello({ major: 2, minor: 0, capabilities: [] })).toThrow(/主版本不一致/);
    // 同主版本（次版本可更高）不抛错
    expect(() => assertCompatibleHello({ major: PROTOCOL_MAJOR, minor: 5, capabilities: [] })).not.toThrow();
  });

  it("命令信封与事件游标：commandId 必填、游标非负", () => {
    expect(CommandEnvelope.parse({ commandId: "c1", method: "session_send", params: {} })).toMatchObject({
      commandId: "c1",
    });
    expect(CommandEnvelope.safeParse({ method: "x", params: {} }).success).toBe(false);
    expect(EventCursor.parse({ logEpoch: 0, seq: 3 }).seq).toBe(3);
    expect(EventCursor.safeParse({ logEpoch: -1, seq: 0 }).success).toBe(false);
  });
});
