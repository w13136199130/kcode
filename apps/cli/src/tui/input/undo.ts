/**
 * 输入 undo/redo（N3G-2，对标 OC ctrl+z/super+z）：快照双栈——值变化前快照入
 * undo 栈，undo 时当前值入 redo 栈。入栈点合并：100ms 窗口内的连续编辑并为一个
 * 撤销单元（窗口锚定在最近一次入栈，不随跳过刷新——长连打按 ~100ms 分块）；
 * 边界事件（提交/粘贴/IME 上屏/历史回填/清空）跳过合并直接入栈。
 * 取舍：历史上限 50，不持久化（InputBox 本地，覆盖层顶替时自然丢弃）。
 * 纯类无 React 依赖，单测直接驱动。
 */

const MERGE_MS = 100;

export class UndoStack {
  readonly #undo: string[] = [];
  #redo: string[] = [];
  /** -Infinity：首次入栈不受窗口误判（epoch 0 附近不算"刚入过栈"） */
  #lastPushAt = -Infinity;

  constructor(readonly limit = 50) {}

  /**
   * 值即将从 prev 变走时调用：决定 prev 是否入栈。
   * boundary=true 跳过合并窗口（大跳变各自成单元）；任何新入栈使 redo 失效。
   */
  push(prev: string, boundary = false, now = Date.now()): void {
    if (!boundary && now - this.#lastPushAt <= MERGE_MS) {
      return;
    }
    this.#undo.push(prev);
    if (this.#undo.length > this.limit) {
      this.#undo.shift();
    }
    this.#redo = [];
    this.#lastPushAt = now;
  }

  /** 撤销：返回上一快照；当前值入 redo。无可撤销返回 null（保持现值）。 */
  undo(current: string): string | null {
    const prev = this.#undo.pop();
    if (prev === undefined) {
      return null;
    }
    this.#redo.push(current);
    return prev;
  }

  /** 重做：返回下一快照；当前值回 undo。无可重做返回 null。 */
  redo(current: string): string | null {
    const next = this.#redo.pop();
    if (next === undefined) {
      return null;
    }
    this.#undo.push(current);
    return next;
  }

  get depth(): number {
    return this.#undo.length;
  }
}
