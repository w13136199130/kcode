import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Row, TimelineState } from "./projection.js";
import { RowView } from "./rows.js";
import { RichMarkdown } from "./RichMarkdown.js";

/**
 * 虚拟滚动时间线（M2a，§8.4h）：@tanstack/react-virtual 动态测高 + live-tail 拆分——
 * 进行中的流式正文/思考渲染在虚拟列表之外的普通文档流（zcode 教训：running 单元
 * 移出虚拟列表，避免"先长高、下一帧才回填"的测高跳动）。滚动跟随：贴底时自动吸底。
 */
export function Timeline({
  state,
  model,
  onOpenDiff,
  onQuotaReset,
  onQuotaFeedback,
}: {
  state: TimelineState;
  model?: string | null;
  onOpenDiff?: (row: Extract<Row, { kind: "tool" }>) => void;
  onQuotaReset?: () => void;
  onQuotaFeedback?: (text: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const rows = state.rows;
  // D1-04：非工具行不再用下标——replay/复活/滚动时按内容哈希生成稳定 key，
  // 重复内容用出现序号消歧；工具行继续用 callId（状态更新不换 key）。
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return rows.map((row) => {
      const base =
        row.kind === "tool"
          ? `tool:${row.callId}`
          : `${row.kind}:${JSON.stringify(row).slice(0, 160)}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return `${base}#${n}`;
    });
  }, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 8,
    getItemKey: (i) => rowKeys[i] ?? String(i),
  });

  // 用户上滚即脱离吸底；回到底部恢复
  const onScroll = (): void => {
    const el = parentRef.current;
    if (el === null) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    if (!stickToBottomRef.current || rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, virtualizer]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = parentRef.current;
    if (el === null) return;
    // live-tail 在虚拟列表之外；只贴底，不按 token 重新定位虚拟行。
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [state.streamText, state.streamThinking, rows.length]);

  const liveTail =
    state.streamThinking !== "" ? (
      <div className="row-thinking-live">💭 思考中…</div>
    ) : state.streamText !== "" ? (
      <div className="row-assistant live">
        <div className="assistant-meta">
          <span className="assistant-brand">kcode</span>
          {model !== null && model !== undefined && model !== "" ? <span>{model}</span> : null}
        </div>
        <RichMarkdown text={state.streamText} />
      </div>
    ) : state.busy ? (
      <div className="row-busy">
        <span className="spinner" /> 工作中…
      </div>
    ) : null;

  return (
    <div className="timeline timeline-v2" ref={parentRef} onScroll={onScroll}>
      <div className="timeline-inner" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
          >
            <RowView
              row={rows[item.index]!}
              model={model}
              onOpenDiff={onOpenDiff}
              onQuotaReset={onQuotaReset}
              onQuotaFeedback={onQuotaFeedback}
            />
          </div>
        ))}
      </div>
      {liveTail !== null ? <div className="timeline-live-wrap">{liveTail}</div> : null}
      <div className="timeline-bottom-sentinel" style={{ height: 1 }} />
    </div>
  );
}
