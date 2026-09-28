import type { PermissionDecision } from "@kcode/contracts";

/**
 * bash 安全命令直跑门（对标 Claude Code 安全命令表，N2.x 体验项）：
 * 只读/幂等命令（ls、git status、grep 等）免确认直接执行，其余照旧 ask。
 * 保守取向——误放行不可接受，误询问只是多按一次：
 * - 含任何 shell 控制结构（&& || ; | > >> < ` $( ）一律不安全——引号内的也算（不解析引号）；
 * - find 需无 -delete/-exec/-ok/-fprint 才安全；git 仅只读子命令白名单；
 * - plan 档不走此门（只读研究姿态连 bash 一起拒，与原语义一致）。
 */

/** 无副作用即可直跑的单命令（argv[0] 白名单） */
const SAFE_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "echo", "printf",
  "which", "where", "du", "df", "date", "whoami", "uname", "hostname", "id",
  "grep", "rg", "find", "fd", "tree", "basename", "dirname", "realpath", "cygpath",
]);

/** git 只读子命令（不带危险旗标即可直跑） */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "shortlog", "describe", "rev-parse",
  "ls-files", "ls-tree", "whatchanged", "stash", "remote", "symbolic-ref",
  "branch", "tag",
]);

/** git 子命令里出现即不安全的旗标（stash list 安全但 stash drop/pop/clear 有副作用） */
const UNSAFE_GIT_FLAGS = /(^|\s)-(d|D|m|M|e|edit|drop|pop|clear|apply|save)\b/;

/** find 里出现即不安全的动作旗标 */
const UNSAFE_FIND_FLAGS = /(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;

/** shell 控制结构：出现任意一个即视为复合/重定向命令，不直跑（引号内同样拒绝——不解析引号，宁可误问） */
const CONTROL_OPERATORS = /&&|\|\||;|\||>|>>|<|`|\$\(/;

export function isSafeBashCommand(command: string): boolean {
  const text = command.trim();
  if (text === "" || CONTROL_OPERATORS.test(text)) {
    return false;
  }
  const tokens = text.split(/\s+/);
  const head = tokens[0];
  if (head === undefined) {
    return false;
  }
  if (head === "git") {
    const sub = tokens[1];
    if (sub === undefined || !SAFE_GIT_SUBCOMMANDS.has(sub)) {
      return false;
    }
    // git branch/tag/stash 单独收紧：仅列举形态安全（branch -D / tag -d / stash drop 有副作用）
    if (["branch", "tag"].includes(sub)) {
      return /^git (branch|tag)( --?\w+)*$/.test(text) && !UNSAFE_GIT_FLAGS.test(text);
    }
    if (sub === "stash") {
      // stash 的危险动作不带横杠（drop/pop/clear/apply/push/save）：仅裸 stash / stash list 安全
      const action = tokens[2];
      return action === undefined || action === "list";
    }
    return !UNSAFE_GIT_FLAGS.test(text);
  }
  if (head === "find") {
    return !UNSAFE_FIND_FLAGS.test(text);
  }
  return SAFE_COMMANDS.has(head);
}

/**
 * args-aware 裁决装饰（ModePermissionEngine 内嵌）：bash 命中安全表时
 * 在 default/acceptEdits 档升为 allow；其余维持工具声明裁决。
 */
export function safeBashDecision(
  toolName: string,
  args: unknown,
  declared: PermissionDecision,
): PermissionDecision {
  if (toolName !== "bash" || declared === "allow" || declared === "deny") {
    return declared;
  }
  const command = (args as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" && isSafeBashCommand(command) ? "allow" : declared;
}
