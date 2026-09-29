/**
 * 单轮显式状态机（N3D-2 前置，对标 zcode turn-state.ts:230 十态裁剪为八态——
 * kcode 无独立 AwaitingModelResponse（流式即刻开始），权限等待发生在 ExecutingTools 内部）。
 * 价值：① 结构守卫——非法迁移即刻抛错，杜绝"在错误阶段做错误事"的隐式 bug；
 * ② N3D-2 的 steer 注入点以模型步边界为准（AggregatingResults→Streaming），
 * 与状态机边界重合但不耦合（steer 合法性是独立判定，不读 phase——zcode 实证）。
 * 机器不可变推进：每次 transition 校验迁移表并通知观察缝（onPhase 供测试/未来 steer 用）。
 */

export const TurnPhase = {
  Idle: "Idle",
  ProcessingInput: "ProcessingInput",
  Streaming: "Streaming",
  SchedulingTools: "SchedulingTools",
  ExecutingTools: "ExecutingTools",
  AggregatingResults: "AggregatingResults",
  Completing: "Completing",
  Error: "Error",
} as const;
export type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase];

/** 合法迁移表（zcode canTransitionTo 同构；AggregatingResults 保留回 SchedulingTools 位为多轮重调度预留） */
export const TURN_TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  [TurnPhase.Idle]: [TurnPhase.ProcessingInput],
  [TurnPhase.ProcessingInput]: [TurnPhase.Streaming, TurnPhase.Completing],
  [TurnPhase.Streaming]: [
    TurnPhase.SchedulingTools,
    TurnPhase.AggregatingResults,
    TurnPhase.Completing,
    TurnPhase.Error,
  ],
  [TurnPhase.SchedulingTools]: [TurnPhase.ExecutingTools, TurnPhase.Error],
  [TurnPhase.ExecutingTools]: [TurnPhase.AggregatingResults, TurnPhase.Error],
  [TurnPhase.AggregatingResults]: [
    TurnPhase.Streaming,
    TurnPhase.SchedulingTools,
    TurnPhase.Completing,
    TurnPhase.Error,
  ],
  [TurnPhase.Completing]: [TurnPhase.Idle],
  [TurnPhase.Error]: [TurnPhase.Idle],
};

export class TurnMachine {
  #phase: TurnPhase = TurnPhase.Idle;

  constructor(private readonly onTransition?: (from: TurnPhase, to: TurnPhase) => void) {}

  get phase(): TurnPhase {
    return this.#phase;
  }

  canTransitionTo(next: TurnPhase): boolean {
    return TURN_TRANSITIONS[this.#phase].includes(next);
  }

  /** 唯一推进入口：非法迁移抛错（fail-fast——比带着错误状态继续跑更便宜） */
  transition(next: TurnPhase): void {
    if (!this.canTransitionTo(next)) {
      throw new Error(`非法 TurnPhase 迁移：${this.#phase} → ${next}`);
    }
    const from = this.#phase;
    this.#phase = next;
    this.onTransition?.(from, next);
  }

  /** run 收尾归位：Error/Completing→Idle；其余非 Idle 经 Completing→Idle（幂等，重复调用无操作） */
  finish(): void {
    if (this.#phase === TurnPhase.Idle) {
      return;
    }
    if (this.#phase === TurnPhase.Completing) {
      this.transition(TurnPhase.Idle);
      return;
    }
    if (this.#phase !== TurnPhase.Error) {
      this.transition(TurnPhase.Completing);
    }
    this.transition(TurnPhase.Idle);
  }
}
