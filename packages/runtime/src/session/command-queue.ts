/**
 * 运行中输入排队（N2-2 简化版，对标 ZCode CommandInbox 裁剪——不做 500 行幂等网关）：
 * - priority now/next/later 三档，同档 FIFO；now 只保证排在最前，不打断当前轮——打断是调用方策略（CLI：Esc/Ctrl+C）
 * - 单 reservation：tryReserve() 防双 turn——提交入口与排空循环共用，同一时刻至多一个执行者
 * - clear() 绑定中断语义：取消当前轮时应清空待执行项，避免「取消后队列自动续跑」的意外
 * - owner/lease（防 host 重启幽灵写回）随 N3-1 host 进程引入，本层不预埋
 */

export type CommandPriority = "now" | "next" | "later";

export interface QueuedCommand {
  id: number;
  text: string;
  priority: CommandPriority;
  enqueuedAt: number;
}

const RANK: Record<CommandPriority, number> = { now: 0, next: 1, later: 2 };

export class RuntimeCommandQueue {
  private seq = 0;
  private items: QueuedCommand[] = [];
  private reserved = false;
  private readonly onChange?: (items: readonly QueuedCommand[]) => void;

  constructor(onChange?: (items: readonly QueuedCommand[]) => void) {
    this.onChange = onChange;
  }

  get size(): number {
    return this.items.length;
  }

  /** 当前排队快照（界面镜像渲染用） */
  snapshot(): readonly QueuedCommand[] {
    return [...this.items];
  }

  /** 入队：later 尾插；now/next 插到所有更高档之前、同档末尾（稳定） */
  enqueue(text: string, priority: CommandPriority = "later"): QueuedCommand {
    const item: QueuedCommand = { id: ++this.seq, text, priority, enqueuedAt: Date.now() };
    if (priority === "later") {
      this.items.push(item);
    } else {
      const rank = RANK[priority];
      const index = this.items.findIndex((x) => RANK[x.priority] > rank);
      if (index === -1) {
        this.items.push(item);
      } else {
        this.items.splice(index, 0, item);
      }
    }
    this.onChange?.([...this.items]);
    return item;
  }

  /** 取下一条（档位升序、同档 FIFO）；不动 reservation */
  dequeue(): QueuedCommand | undefined {
    const item = this.items.shift();
    if (item !== undefined) {
      this.onChange?.([...this.items]);
    }
    return item;
  }

  /** 清空待执行项，返回清除数（中断时调用：取消即不续跑） */
  clear(): number {
    const cleared = this.items.length;
    if (cleared > 0) {
      this.items = [];
      this.onChange?.([...this.items]);
    }
    return cleared;
  }

  /** 单 reservation（ZCode ActiveTurnStartReservation 简化版）：防双 turn */
  tryReserve(): boolean {
    if (this.reserved) {
      return false;
    }
    this.reserved = true;
    return true;
  }

  release(): void {
    this.reserved = false;
  }
}
