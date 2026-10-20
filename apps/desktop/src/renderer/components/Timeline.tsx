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
  onOpenDiff,
}: {
  state: TimelineState;
  onOpenDiff?: (row: Extract<Row, { kind: "tool" }>) => void;
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
    if (stickToBottomRef.current) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [rows.length, state.streamText, state.streamThinking, virtualizer]);

  const liveTail =
    state.streamThinking !== "" ? (
      <div className="row-thinking-live">💭 思考中…</div>
    ) : state.streamText !== "" ? (
      <div className="row-assistant live">
        <RichMarkdown text={state.streamText} />
      </div>
    ) : state.busy ? (
      <div className="row-busy">
        <span className="spinner" /> 工作中…
      </div>
    ) : null;

  return (
    <div className="timeline" ref={parentRef} onScroll={onScroll}>
      <div className="timeline-inner" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
          >
            <RowView row={rows[item.index]!} onOpenDiff={onOpenDiff} />
          </div>
        ))}
      </div>
      {liveTail}
      <div className="timeline-bottom-sentinel" style={{ height: 1 }} />
    </div>
  );
}
