import type { LLMChunk, LLMProvider, LLMRequest } from "@kcode/contracts";

/**
 * 2-02：LLM 延迟解析。
 * composeSession 阶段只拿一个工厂，不触碰 keychain/路由；第一次 stream/listModels
 * 才真正 resolve。这样没有配置/key 也能进 TUI，把错误推迟到第一次请求（或 /login 后重试）。
 */
export class LazyLlmProvider implements LLMProvider {
  #factory: () => Promise<LLMProvider>;
  #promise: Promise<LLMProvider> | null = null;
  #inner: LLMProvider | null = null;

  constructor(factory: () => Promise<LLMProvider>) {
    this.#factory = factory;
  }

  /** 未解析时是占位 id；解析后透传真实 provider id（事件/诊断可见） */
  get id(): string {
    return this.#inner?.id ?? "lazy";
  }

  /** 已解析的 provider（测试/诊断；未解析为 null） */
  get resolved(): LLMProvider | null {
    return this.#inner;
  }

  #resolve(): Promise<LLMProvider> {
    if (this.#promise === null) {
      this.#promise = this.#factory().then(
        (llm) => {
          this.#inner = llm;
          return llm;
        },
        (err: unknown) => {
          // 解析失败（未登录/配置缺失）不缓存：/login 写入后同会话重试应能成功
          this.#promise = null;
          throw err;
        },
      );
    }
    return this.#promise;
  }

  async *stream(req: LLMRequest): AsyncIterable<LLMChunk> {
    const llm = await this.#resolve();
    yield* llm.stream(req);
  }

  async listModels(): Promise<string[]> {
    const llm = await this.#resolve();
    return llm.listModels !== undefined ? llm.listModels() : [];
  }
}
