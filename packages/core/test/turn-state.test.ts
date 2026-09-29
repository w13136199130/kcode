import { describe, expect, it } from "vitest";
import { TurnMachine, TurnPhase, TURN_TRANSITIONS } from "../src/core/turn-state.js";

/** N3D-2 前置：八态迁移表与强制点的单元行为 */

describe("TurnMachine（显式状态机）", () => {
  it("起始 Idle；合法链路全程可走（输入→流式→调度→执行→聚合→循环/完成→归位）", () => {
    const m = new TurnMachine();
    expect(m.phase).toBe(TurnPhase.Idle);
    m.transition(TurnPhase.ProcessingInput);
    m.transition(TurnPhase.Streaming);
    m.transition(TurnPhase.SchedulingTools);
    m.transition(TurnPhase.ExecutingTools);
    m.transition(TurnPhase.AggregatingResults);
    m.transition(TurnPhase.Streaming); // 多轮：聚合后回流式（模型步边界）
    m.transition(TurnPhase.AggregatingResults);
    m.transition(TurnPhase.Completing);
    m.finish();
    expect(m.phase).toBe(TurnPhase.Idle);
  });

  it("非法迁移抛错并保持原状态（fail-fast，不带着错误状态继续跑）", () => {
    const m = new TurnMachine();
    expect(() => m.transition(TurnPhase.ExecutingTools)).toThrow("非法 TurnPhase 迁移");
    expect(m.phase).toBe(TurnPhase.Idle);
    m.transition(TurnPhase.ProcessingInput);
    expect(() => m.transition(TurnPhase.ExecutingTools)).toThrow(); // 输入期不可直接执行
    expect(m.phase).toBe(TurnPhase.ProcessingInput);
  });

  it("finish()：Error→Idle 直接归位；非终态经 Completing；重复调用幂等", () => {
    const a = new TurnMachine();
    a.transition(TurnPhase.ProcessingInput);
    a.transition(TurnPhase.Streaming);
    a.transition(TurnPhase.Error);
    a.finish();
    expect(a.phase).toBe(TurnPhase.Idle);

    const b = new TurnMachine();
    b.transition(TurnPhase.ProcessingInput);
    b.finish();
    expect(b.phase).toBe(TurnPhase.Idle);
    b.finish(); // 幂等
    expect(b.phase).toBe(TurnPhase.Idle);
  });

  it("onTransition 观察缝收到 (from, to) 序列", () => {
    const seen: string[] = [];
    const m = new TurnMachine((from, to) => seen.push(`${from}->${to}`));
    m.transition(TurnPhase.ProcessingInput);
    m.transition(TurnPhase.Streaming);
    m.finish();
    expect(seen).toEqual(["Idle->ProcessingInput", "ProcessingInput->Streaming", "Streaming->Completing", "Completing->Idle"]);
  });

  it("迁移表覆盖全部八态且 Completing/Error 只回 Idle（终态语义）", () => {
    expect(Object.keys(TURN_TRANSITIONS)).toHaveLength(8);
    expect(TURN_TRANSITIONS[TurnPhase.Completing]).toEqual([TurnPhase.Idle]);
    expect(TURN_TRANSITIONS[TurnPhase.Error]).toEqual([TurnPhase.Idle]);
  });
});
