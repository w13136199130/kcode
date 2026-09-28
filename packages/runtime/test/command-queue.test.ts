import { describe, expect, it } from "vitest";
import { RuntimeCommandQueue, type QueuedCommand } from "../src/session/command-queue.js";

/** 收集 onChange 通知的快照长度序列 */
function notified() {
  const sizes: number[] = [];
  const q = new RuntimeCommandQueue((items) => sizes.push(items.length));
  return { q, sizes };
}

describe("RuntimeCommandQueue（N2-2 简化版准入队列）", () => {
  it("later 同档 FIFO：入队按序出队", () => {
    const q = new RuntimeCommandQueue();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    expect(q.size).toBe(3);
    expect([q.dequeue()?.text, q.dequeue()?.text, q.dequeue()?.text]).toEqual(["a", "b", "c"]);
    expect(q.dequeue()).toBeUndefined();
  });

  it("priority 插队：now 排最前、next 排其后，同档仍 FIFO", () => {
    const q = new RuntimeCommandQueue();
    q.enqueue("later-1");
    q.enqueue("later-2");
    q.enqueue("next-1", "next");
    q.enqueue("now-1", "now");
    q.enqueue("next-2", "next");
    q.enqueue("now-2", "now");
    q.enqueue("later-3");
    const order = [1, 2, 3, 4, 5, 6, 7].map(() => q.dequeue()?.text);
    expect(order).toEqual(["now-1", "now-2", "next-1", "next-2", "later-1", "later-2", "later-3"]);
  });

  it("单 reservation：同一时刻至多一个 tryReserve 成功，release 后可再约", () => {
    const q = new RuntimeCommandQueue();
    expect(q.tryReserve()).toBe(true);
    expect(q.tryReserve()).toBe(false);
    q.release();
    expect(q.tryReserve()).toBe(true);
  });

  it("clear：清空并返回条数（中断语义——取消即不续跑）", () => {
    const q = new RuntimeCommandQueue();
    q.enqueue("a");
    q.enqueue("b");
    expect(q.clear()).toBe(2);
    expect(q.size).toBe(0);
    expect(q.clear()).toBe(0);
  });

  it("onChange 在入队/出队/清空时通知快照（界面镜像）", () => {
    const { q, sizes } = notified();
    q.enqueue("a");
    q.enqueue("b");
    q.dequeue();
    q.clear();
    expect(sizes).toEqual([1, 2, 1, 0]);
  });

  it("快照只读语义：外部改动不影响队列内部", () => {
    const q = new RuntimeCommandQueue();
    q.enqueue("a");
    const snap = q.snapshot() as QueuedCommand[];
    snap.pop();
    expect(q.size).toBe(1);
    expect(q.dequeue()?.text).toBe("a");
  });
});
