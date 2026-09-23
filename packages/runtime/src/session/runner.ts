import { newId } from "@kcode/shared";

/** 同一会话只允许一个运行；锁在第一个 await 之前取得，直到工作真正退出才释放。 */
export class SessionRunner {
  private active?: { id: string; controller: AbortController };

  get runId(): string | undefined { return this.active?.id; }
  get busy(): boolean { return this.active !== undefined; }

  start<T>(work: (signal: AbortSignal) => Promise<T>, id = newId("run")): { runId: string; result: Promise<T> } {
    if (this.active !== undefined) throw new Error("会话正在运行，请等待完成或先中断");
    const active = { id, controller: new AbortController() };
    this.active = active;
    const result = Promise.resolve().then(() => work(active.controller.signal)).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    return { runId: id, result };
  }

  abort(runId?: string): boolean {
    if (this.active === undefined || (runId !== undefined && this.active.id !== runId)) return false;
    this.active.controller.abort();
    return true;
  }
}
