import type { GrantPattern } from "@kcode/extensions";
import { formatGrantPattern } from "@kcode/extensions";
import { truncateVisual } from "../terminal/width.js";

/**
 * 4-02 后续交互修：审批菜单的授权范围文案必须单行、可扫。
 * 复合/多行命令的「建议规则」是整串精确命令——不能再把整段命令塞进两个选项，
 * 否则多行命令会把菜单撑成几十行。规则单独一行（截断），选项只讲范围。
 */
export interface AskScopeLabels {
  session: string;
  project: string;
  /** 将保存的规则（单行截断）；null = 无参数级建议 */
  rule: string | null;
}

const RULE_PREVIEW_MAX = 72;

/** 判断建议规则是“此命令/文件”还是“此类”：含 * 才是类，否则精确 */
function isBroad(pattern: GrantPattern): boolean {
  return pattern.content !== undefined && pattern.content.includes("*");
}

export function askScopeLabels(suggestion: GrantPattern | null): AskScopeLabels {
  if (suggestion === null) {
    return {
      session: "允许，本会话不再询问",
      project: "允许，本项目不再询问（持久）",
      rule: null,
    };
  }
  const subject = isBroad(suggestion) ? "允许此类" : "允许此命令";
  const oneLine = formatGrantPattern(suggestion).replace(/\s+/g, " ").trim();
  return {
    session: `${subject}，本会话不再询问`,
    project: `${subject}，本项目不再询问`,
    rule: truncateVisual(oneLine, RULE_PREVIEW_MAX),
  };
}
