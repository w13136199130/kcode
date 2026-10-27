import type { SubagentCard, TodoStep } from "./projection.js";

/**
 * P4-2（F16）：右上浮动进度卡——步骤 `2/5` + 子智能体卡。
 * absolute 悬浮在时间线右上角（不占栏、不推挤内容）；运行中（busy 或有运行中
 * 子代理）且存在可显示内容时出现，空闲即收起。
 */
export function RuntimeProgressCard({
  todos,
  agents,
  busy,
}: {
  todos: TodoStep[];
  agents: SubagentCard[];
  busy: boolean;
}) {
  const agentRunning = agents.some((a) => a.status === "running");
  if ((!busy && !agentRunning) || (todos.length === 0 && agents.length === 0)) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    <div className="runtime-progress-card">
      {todos.length > 0 ? (
        <>
          <div className="rpc-title">
            进度 <span className="rpc-count">{done}/{todos.length}</span>
            {busy || agentRunning ? <span className="spinner rpc-spin" /> : null}
          </div>
          <div className="rpc-steps">
            {current !== undefined ? (
              <div className="rpc-step status-in_progress">◐ {current.content}</div>
            ) : null}
            {todos
              .filter((t) => t.status !== "in_progress")
              .map((t) => (
                <div key={t.content} className={`rpc-step status-${t.status}`}>
                  {t.status === "completed" ? "☑" : "☐"} {t.content}
                </div>
              ))}
          </div>
        </>
      ) : null}
      {agents.length > 0 ? (
        <div className="rpc-agents">
          {agents.map((a) => (
            <div key={a.agentId} className={`rpc-agent status-${a.status}`}>
              <span className="rpc-agent-head">
                🤖 {a.agentType}
                <span className="rpc-agent-status">
                  {a.status === "running"
                    ? "运行中"
                    : a.status === "completed"
                      ? `完成·${a.turns ?? 0} 轮`
                      : a.status === "failed"
                        ? "失败"
                        : "已停止"}
                </span>
              </span>
              <span className="rpc-agent-desc">{a.description}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
