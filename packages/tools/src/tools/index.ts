import type { Tool } from "@kcode/contracts";
import { readTool } from "./read.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";

export { readTool } from "./read.js";
export { globTool } from "./glob.js";
export { grepTool } from "./grep.js";

/** P1 只读三件套（§9）：read / glob / grep（捆绑 ripgrep），全部 readOnly → 循环内自动并发 */
export const readOnlyTools: Tool[] = [readTool, globTool, grepTool];
