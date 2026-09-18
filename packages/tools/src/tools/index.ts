import type { Tool } from "@kcode/contracts";
import { readTool } from "./read.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { createBashTool, type BashToolOptions } from "./bash.js";

export { readTool } from "./read.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { writeTool } from "./write.js";
export { editTool } from "./edit.js";
export { createBashTool, BackgroundTaskRegistry, type BashToolOptions, type BackgroundTask } from "./bash.js";
export { resolveInCtx, displayPath } from "./paths.js";

/** P1 只读三件套（§9）：read / glob / grep（捆绑 ripgrep），全部 readOnly → 循环内自动并发 */
export const readOnlyTools: Tool[] = [readTool, globTool, grepTool];

/** P1-4 写入两件套（默认预设下走 ask 确认） */
export const writableTools: Tool[] = [writeTool, editTool];

/** 内置工具全集（不含需要会话态的 bash） */
export const builtinTools: Tool[] = [...readOnlyTools, ...writableTools];

/** 会话工具全集：含 bash（后台任务日志/通知挂在会话上） */
export function createSessionTools(opts: BashToolOptions): Tool[] {
  return [...builtinTools, createBashTool(opts)];
}
