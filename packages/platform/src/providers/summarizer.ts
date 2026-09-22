import type {
  ChatMessage,
  LLMProvider,
  SummarizerInput,
  SummarizerPort,
} from "@kcode/contracts";

/** 送入摘要提示词的转写长度上限：超出部分截断，控制单次摘要成本 */
const TRANSCRIPT_CHAR_CAP = 60_000;

const SUMMARY_SYSTEM_PROMPT =
  "你是对话压缩器。把历史对话压缩为结构化摘要，必须保留：" +
  "1) 任务目标；2) 关键文件路径与已确认的结论；3) 已做出的决定；4) 未完成事项；5) 已批准的执行计划要点。" +
  "直接输出摘要正文，不要任何解释或前后缀。";

/**
 * 基于模型调用的历史摘要器：把待压缩消息转写为提示词，由模型输出结构化摘要。
 * 默认与对话共用一个模型实例；若需节省成本，可在组合层注入更便宜的模型。
 */
export class LlmSummarizer implements SummarizerPort {
  constructor(
    private readonly llm: LLMProvider,
    private readonly model: string,
  ) {}

  async summarize(input: SummarizerInput): Promise<string> {
    let transcript = formatTranscript(input.messages);
    if (transcript.length > TRANSCRIPT_CHAR_CAP) {
      transcript = `${transcript.slice(0, TRANSCRIPT_CHAR_CAP)}\n（中略：转写超长已截断）`;
    }
    let summary = "";
    for await (const chunk of this.llm.stream({
      model: this.model,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    })) {
      if (chunk.type === "text") {
        summary += chunk.text;
      }
    }
    const trimmed = summary.trim();
    return trimmed !== "" ? trimmed : "【历史压缩】摘要生成为空，已折叠早期消息。";
  }
}

/** 把消息列表转写为「角色: 内容」的纯文本，工具结果附带来源标识 */
function formatTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who =
      m.role === "user"
        ? "用户"
        : m.role === "assistant"
          ? "助手"
          : `工具(${m.name ?? m.toolCallId ?? "未知"})`;
    lines.push(`${who}: ${m.content}`);
  }
  return lines.join("\n");
}
