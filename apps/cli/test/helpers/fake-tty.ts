import { EventEmitter } from "node:events";

/**
 * 忠实的 TTY stdin 假实现（Ink 测试专用）。
 *
 * 为什么需要它：Ink 4 的输入通道是 `stdin.addListener('readable', …)` +
 * `stdin.read()` 同步取块（见 ink/build/components/App.js 的 handleReadable）。
 * 用 `Object.assign(new PassThrough(), { setRawMode() {} })` 当假 TTY 时：
 * setRawMode 是空实现，流不会 resume，停止态下 write() 只进内部缓冲、
 * 永不触发 'readable' —— 表现为「界面渲染正常但任何按键都无响应」（测试挂死）。
 *
 * 本实现提供真实 TTY 的关键语义：
 * - setRawMode(true) 让流可读（自动向注册的 readable 监听器补发通知）；
 * - read() 按字符串 chunk 取块，语义等价于 Node 流的 paused 模式读取；
 * - resume()/pause()、isPaused()、isTTY 等被 Ink 直接查询的属性齐备。
 */
export interface FakeTtyStdinOptions {
  columns?: number;
  rows?: number;
}

export class FakeTtyStdin extends EventEmitter {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;

  #chunks: string[] = [];
  #rawMode = false;
  /** 有数据待通知但当时还没有 readable 监听者（Ink effect 尚未注册） */
  #pendingReadable = false;

  constructor(options: FakeTtyStdinOptions = {}) {
    super();
    this.columns = options.columns ?? 120;
    this.rows = options.rows ?? 40;
    // Ink 在 effect 里才 addListener('readable')；此前错过的事件在此补发，
    // 否则「先写入、后注册监听」的时序会静默丢键。
    this.on("newListener", (event: string) => {
      if (event === "readable" && this.#pendingReadable) {
        this.#pendingReadable = false;
        queueMicrotask(() => this.emit("readable"));
      }
    });
  }

  /** 当前是否处于 raw 模式（Ink 进出处分别调用 setRawMode(true/false)） */
  get isRaw(): boolean {
    return this.#rawMode;
  }

  setRawMode(mode: boolean): void {
    this.#rawMode = mode;
    if (mode) {
      // 真实 TTY 在 raw 模式下始终可读：通知已注册的 readable 监听器
      this.#notifyReadable();
    }
  }

  get isRawModeSupported(): boolean {
    return true;
  }

  /** 模拟按键/粘贴：进入缓冲并通知 readable 监听器（真实终端会自发此事件） */
  write(text: string): boolean {
    this.#chunks.push(text);
    this.#notifyReadable();
    return true;
  }

  /** 兼容 process.stdin 调用形状：Ink 不直接调它，但测试/工具可能调用 */
  push(text: string): void {
    this.write(text);
  }

  read(): string | null {
    if (this.#chunks.length === 0) {
      return null;
    }
    return this.#chunks.shift() ?? null;
  }

  resume(): this {
    this.#notifyReadable();
    return this;
  }

  pause(): this {
    return this;
  }

  isPaused(): boolean {
    return this.#chunks.length === 0;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  setEncoding(): this {
    return this;
  }

  destroy(): void {
    this.#chunks = [];
    this.removeAllListeners();
  }

  #notifyReadable(): void {
    if (this.listenerCount("readable") === 0) {
      // 监听者尚未注册：挂起，待 newListener 时补发（不丢事件）
      this.#pendingReadable = true;
      return;
    }
    // 用微任务派发，让同一轮写入的多个 chunk 各自被 read() 取走
    queueMicrotask(() => {
      if (this.listenerCount("readable") > 0) {
        this.emit("readable");
      } else {
        this.#pendingReadable = true;
      }
    });
  }
}
