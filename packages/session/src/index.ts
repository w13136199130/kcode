/**
 * 会话引擎组装（C 级单进程化的核心拆包）：
 * composeSession 与其配套（子代理/计划闸门/检查点）是纯组装层，
 * 由 CLI 进程内嵌组装（单进程默认形态）消费。
 */
export {
  composeSession,
  resolveResumeHistory,
  trustProject,
  SYSTEM_PROMPT,
  PLAN_MODE_SUFFIX,
  type ComposeSessionOptions,
  type ComposedSession,
} from "./composition.js";
export { buildTaskTool, SUBAGENT_MAX_TURNS, type TaskToolDeps } from "./subagent.js";
export { buildPlanSubmitTool, type PlanVerdict, type PlanSubmitToolDeps } from "./plan-submit.js";
export { CheckpointStore, withFileCheckpoints } from "./checkpoints.js";
