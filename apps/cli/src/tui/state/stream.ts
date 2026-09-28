import type { Block, UiStore } from "@kcode/ui";

/**
 * 流式控制器（N2-3 外迁）：正文增量实时入 store；思考摘要量大、逐条入 store 会拖垮渲染，
 * 内部 ref 缓冲 + 时钟合帧（syncReasoningDisplay）；flushStream 把缓冲定格为完成块。
 */
export interface StreamController {
  appendDelta(delta: string): void;
  appendReasoning(delta: string): void;
  flushStream(): void;
  /** 时钟合帧：把思考缓冲批量搬进 store 显示（250ms 一拍） */
  syncReasoningDisplay(): void;
}

export function createStreamController(ui: UiStore): StreamController {
  const reasoning = { text: "", startedAt: null as number | null };
  const pushBlock = (block: Block): void => {
    ui.getState().pushBlock(block);
  };
  return {
    appendDelta: (delta: string): void => {
    ui.getState().setPhase("接收模型回复");
    ui.getState().appendStream(delta);
    },


    appendReasoning: (delta: string): void => {
      ui.getState().setPhase("接收模型思考摘要");
      if (reasoning.startedAt === null) {
        reasoning.startedAt = Date.now();
      }
      reasoning.text += delta;
    },

    /** 把流式缓冲定格为完成块（工具调用开始或轮次完成时）；思考折叠为单行摘要 */
    flushStream: (): void => {
      if (reasoning.text !== "") {
        const text = reasoning.text;
        const ms = reasoning.startedAt !== null ? Date.now() - reasoning.startedAt : undefined;
        reasoning.text = "";
        reasoning.startedAt = null;
        ui.getState().setReasoningDisplay("");
        pushBlock({ kind: "reasoning", text, ...(ms !== undefined ? { ms } : {}) });
      }
      ui.getState().flushAssistant();
    },

    syncReasoningDisplay(): void {
      ui.getState().setReasoningDisplay(reasoning.text);
    },
  };
}
