import type { HostEvent } from "@kcode/contracts";
import { applyEvent, type TimelineState } from "../components/projection.js";

/**
 * S2-1：会话级时间线分片（多会话并行的地基）。
 * 事实约束：宿主事件里只有 session/event 信封内带 sessionId；delta/reasoning/
 * tool/preview/notice 等无 id——单宿主单活动会话模型下归属"当前会话"。
 * 用途：① 切换会话时暂存/秒恢复（切回即见旧画面，重放随后权威重建）；
 * ② 后台会话事件（未来多会话）按 id 路由进对应分片，不串到当前画面。
 */
export const SHARD_LIMIT = 8;

/** 提取事件归属的会话 id；无 id 的顶层事件返回 null（=当前会话）。 */
export function sessionOfEvent(ev: HostEvent): string | null {
  if (ev.type !== "session/event") return null;
  const sid = (ev as { event?: { sessionId?: unknown } }).event?.sessionId;
  return typeof sid === "string" && sid !== "" ? sid : null;
}

/** LRU 分片表：最近使用的会话保留缓存，超限淘汰最旧（切回被淘汰会话走全量重放，行为不变）。 */
export class TimelineShards {
  readonly #map = new Map<string, TimelineState>();

  save(sessionId: string | null, state: TimelineState): void {
    if (sessionId === null || sessionId === "") return;
    this.#map.delete(sessionId); // LRU 触碰
    this.#map.set(sessionId, state);
    while (this.#map.size > SHARD_LIMIT) {
      this.#map.delete(this.#map.keys().next().value as string);
    }
  }

  /** 取出并移除分片（重放将权威重建，不保留双份）。无缓存返回 null。 */
  take(sessionId: string): TimelineState | null {
    const state = this.#map.get(sessionId) ?? null;
    this.#map.delete(sessionId);
    return state;
  }

  /** 后台事件并入已缓存分片；未缓存的会话不追建（等切换时全量重放）。 */
  apply(sessionId: string, ev: HostEvent): void {
    const state = this.#map.get(sessionId);
    if (state !== undefined) this.#map.set(sessionId, applyEvent(state, ev));
  }

  has(sessionId: string): boolean {
    return this.#map.has(sessionId);
  }

  get size(): number {
    return this.#map.size;
  }
}
