import { describe, expect, it } from "vitest";
import type { HostEvent } from "@kcode/contracts";
import { applyEvent, initialTimeline } from "../src/renderer/components/projection.js";
import { SHARD_LIMIT, sessionOfEvent, TimelineShards } from "../src/renderer/lib/timeline-shards.js";

const ev = (sessionId: string, type: string, content: string): HostEvent =>
  ({ type: "session/event", event: { v: 1, type, ts: 1, sessionId, content } }) as unknown as HostEvent;

describe("S2-1 会话级时间线分片", () => {
  it("sessionOfEvent：session/event 取内层 sessionId；其余顶层事件归属当前（null）", () => {
    expect(sessionOfEvent(ev("s1", "user_message", "hi"))).toBe("s1");
    expect(sessionOfEvent({ type: "delta", text: "x" } as HostEvent)).toBeNull();
    expect(sessionOfEvent({ type: "notice", message: "m" } as HostEvent)).toBeNull();
  });

  it("两会话事件互不串：B 的后台事件只更新 B 的缓存分片，A 分片不动", () => {
    const shards = new TimelineShards();
    let a = initialTimeline();
    a = applyEvent(a, ev("sA", "user_message", "A 的问题"));
    let b = initialTimeline();
    b = applyEvent(b, ev("sB", "user_message", "B 的问题"));
    shards.save("sA", a);
    shards.save("sB", b);

    shards.apply("sB", ev("sB", "assistant_message", "B 的回答"));
    const restoredA = shards.take("sA");
    const restoredB = shards.take("sB");
    expect(restoredA?.rows).toHaveLength(1);
    expect(restoredB?.rows).toHaveLength(2);
    expect(JSON.stringify(restoredA)).not.toContain("B 的");
  });

  it("LRU 上限：超出 SHARD_LIMIT 淘汰最旧；take 后分片移除", () => {
    const shards = new TimelineShards();
    for (let i = 0; i < SHARD_LIMIT + 2; i += 1) shards.save(`s${i}`, initialTimeline());
    expect(shards.size).toBe(SHARD_LIMIT);
    expect(shards.has("s0")).toBe(false);
    expect(shards.has(`s${SHARD_LIMIT + 1}`)).toBe(true);
    expect(shards.take(`s${SHARD_LIMIT + 1}`)).not.toBeNull();
    expect(shards.has(`s${SHARD_LIMIT + 1}`)).toBe(false);
  });

  it("save(null) 忽略；未缓存会话的后台事件不追建", () => {
    const shards = new TimelineShards();
    shards.save(null, initialTimeline());
    expect(shards.size).toBe(0);
    shards.apply("ghost", ev("ghost", "user_message", "x"));
    expect(shards.has("ghost")).toBe(false);
  });
});
