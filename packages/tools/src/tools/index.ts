import type { SessionSink, Tool, UserPromptPort } from "@kcode/contracts";
import { readTool } from "./read.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { createBashTool, type BashToolOptions } from "./bash.js";
import { createTaskTools } from "./task-tools.js";
import { createTodoTool } from "./todo.js";
import { createAskUserTool } from "./ask-user.js";
import { extractTool } from "./extract.js";

export { readTool } from "./read.js";
export { atomicWriteText } from "./atomic-write.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";
export { writeTool } from "./write.js";
export { editTool } from "./edit.js";
export { createBashTool, BackgroundTaskRegistry, type BashToolOptions, type BackgroundTask, currentShellInfo, extractShellSnapshot, msysPathToWin32 } from "./bash.js";
export { detectWindowsBash, pickBashCandidates } from "./shell-detect.js";
export { OutputCollector, DEFAULT_OUTPUT_LIMITS, type OutputLimits } from "./output-collector.js";
export { createTaskTools } from "./task-tools.js";
export { createTodoTool, type TodoToolOptions } from "./todo.js";
export { createAskUserTool } from "./ask-user.js";
export { resolveInCtx, displayPath } from "./paths.js";
export { buildAskPreview, renderDiff, type AskPreview } from "./ask-preview.js";
export { extractTool, parsePageRange } from "./extract.js";
export { webFetchTool, webSearchTool, createWebTools, resolveSearchBackend, type WebToolOptions, type SearchBackend } from "./web.js";
// doctor 自检需要确认捆绑 rg 的落点：经包公共出口转出，避免 apps 直接依赖 @vscode/ripgrep
export { rgPath } from "@vscode/ripgrep";

/** P1 只读三件套（§9）：read / glob / grep（捆绑 ripgrep），全部 readOnly → 循环内自动并发 */
export const readOnlyTools: Tool[] = [readTool, globTool, grepTool, extractTool];

/** P1-4 写入两件套（默认预设下走 ask 确认） */
export const writableTools: Tool[] = [writeTool, editTool];

/** 内置工具全集（不含需要会话态的 bash/todo/ask_user） */
export const builtinTools: Tool[] = [...readOnlyTools, ...writableTools];

/** 会话工具选项：bash 后台日志/通知、todo 事件落盘、ask_user 用户应答 */
export interface SessionToolOptions extends BashToolOptions {
  sink?: SessionSink;
  prompt?: UserPromptPort;
}

/** 会话工具全集：含 bash / todo / ask_user（会话态挂在会话上）+ 后台任务控制（注册表注入时） */
export function createSessionTools(opts: SessionToolOptions): Tool[] {
  return [
    ...builtinTools,
    createBashTool(opts),
    createTodoTool({ sessionId: opts.sessionId, sink: opts.sink }),
    createAskUserTool({ prompt: opts.prompt }),
    ...(opts.registry !== undefined ? createTaskTools(opts.registry) : []),
  ];
}
