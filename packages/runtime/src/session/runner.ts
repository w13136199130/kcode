import { newId } from "@kcode/shared";

/** 同一会话只允许一个运行；锁在第一个 await 之前取得，直到工作真正退出才释放。 */
export class SessionRunner {
  private active?: { id: string; controller: AbortController };
  /** 最近一次 run 的静默结算信号（成功/失败都 resolve） */
  private done: Promise<void> = Promise.resolve();

  get runId(): string | undefined { return this.active?.id; }
  get busy(): boolean { return this.active !== undefined; }

  start<T>(work: (signal: AbortSignal) => Promise<T>, id = newId("run")): { runId: string; result: Promise<T> } {
    if (this.active !== undefined) throw new Error("会话正在运行，请等待完成或先中断");
    const active = { id, controller: new AbortController() };
    this.active = active;
    const result = Promise.resolve().then(() => work(active.controller.signal)).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    // 结算信号吞掉异常：drain 只关心"是否退出"，错误仍由 result 的消费者处理
    this.done = result.then(() => undefined, () => undefined);
    return { runId: id, result };
  }

  abort(runId?: string): boolean {
    if (this.active === undefined || (runId !== undefined && this.active.id !== runId)) return false;
    this.active.controller.abort();
    return true;
  }

  /**
   * 等待当前 run 真正退出（close/关窗用）。abort 只发信号，不保证立即结算；
   * 最多等 timeoutMs，避免工具/网络挂死把进程退出也拖死。
   */
  async drain(timeoutMs = 2_000): Promise<void> {
    if (!this.busy) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      void this.done.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
