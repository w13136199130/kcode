import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 前台命令输出三段预算（N3E-1，对标 zcode OutputCollector `output-collector.ts:51`）：
 * - 内联段：随工具结果直接回灌模型（默认 30k 字符）
 * - 落盘段：超出内联预算时全文写 artifact 文件（默认上限 1M 字符内存保有，超出保头尾）
 * - 尾部段：内联截断时保留最后 2k 字符——构建日志类输出"结尾才是结论"
 * 与 loop 层 capToolResult 职责分离：本层保证"全文不丢"，回灌上下文的 token 预算归 loop 层。
 */

export interface OutputLimits {
  /** 内联上限（超出即触发落盘+截断编排） */
  maxInlineChars: number;
  /** 截断编排中保留的尾部字符数 */
  tailChars: number;
  /** 内存保有上限：超出后只保头尾两半，中间丢弃（总量继续计数） */
  hardCapChars: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxInlineChars: 30_000,
  tailChars: 2_000,
  hardCapChars: 1_000_000,
};

export interface CollectorResult {
  /** 组装后的最终输出（未超限=原文；超限=头+省略注+尾） */
  text: string;
  totalChars: number;
  /** 全文（或头尾保有）是否已落盘 */
  artifactPath?: string;
}

export class OutputCollector {
  #head = "";
  #tail = "";
  #total = 0;
  readonly #limits: OutputLimits;
  readonly #artifactPath?: string;

  constructor(limits: Partial<OutputLimits> = {}, artifactPath?: string) {
    this.#limits = { ...DEFAULT_OUTPUT_LIMITS, ...limits };
    this.#artifactPath = artifactPath;
  }

  append(chunk: string): void {
    this.#total += chunk.length;
    if (this.#total <= this.#limits.hardCapChars) {
      this.#head += chunk; // 未过硬顶：head 即全文
      return;
    }
    // 硬顶后：head 冻结为前半，后续增量滑入 tail 环形保有
    if (this.#head.length > this.#limits.hardCapChars / 2 && this.#tail === "") {
      this.#tail = this.#head.slice(this.#limits.hardCapChars / 2);
      this.#head = this.#head.slice(0, this.#limits.hardCapChars / 2);
    }
    this.#tail = (this.#tail + chunk).slice(-Math.floor(this.#limits.hardCapChars / 2));
  }

  /** 当前保有文本的连续视图（打点行提取等整段处理用；硬顶后为 头+缺口注+尾） */
  getText(): string {
    if (this.#total <= this.#limits.hardCapChars) {
      return this.#head;
    }
    const omitted = this.#total - this.#head.length - this.#tail.length;
    return `${this.#head}\n…（输出超过内存保有上限，中间省略 ${omitted} 字符）\n${this.#tail}`;
  }

  get totalChars(): number {
    return this.#total;
  }

  /**
   * 终态编排：未超内联=原文；超限=全文落盘 + 头/省略注/尾组装。
   * transform 在组装与落盘前应用于全文（调用方借此先剥打点行等尾部标记）。
   */
  async finish(transform?: (full: string) => string): Promise<CollectorResult> {
    const full = transform !== undefined ? transform(this.getText()) : this.getText();
    if (this.#total <= this.#limits.maxInlineChars) {
      return { text: full, totalChars: this.#total };
    }
    let artifactPath: string | undefined;
    if (this.#artifactPath !== undefined) {
      try {
        await mkdir(dirname(this.#artifactPath), { recursive: true });
        await writeFile(this.#artifactPath, full, "utf8");
        artifactPath = this.#artifactPath;
      } catch {
        artifactPath = undefined; // 落盘失败降级：仅截断并在注记中建议重定向
      }
    }
    const headBudget = Math.max(0, this.#limits.maxInlineChars - this.#limits.tailChars - 200);
    const head = full.slice(0, headBudget);
    const tail = full.slice(-this.#limits.tailChars);
    const note = artifactPath !== undefined
      ? `…（输出共 ${this.#total} 字符，中间省略；完整日志已保存：${artifactPath}；以下为末尾）`
      : `…（输出共 ${this.#total} 字符，中间省略；日志目录不可写未落盘——大输出建议用 "> 文件" 重定向后按需读取）`;
    return { text: `${head}\n${note}\n${tail}`, totalChars: this.#total, artifactPath };
  }
}
