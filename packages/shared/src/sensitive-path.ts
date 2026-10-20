/**
 * 2-14：敏感路径判定（纯函数，shared 层供 tools / extensions 共用）。
 * 只做路径形状判断，不读文件；调用方决定 ask/deny 或过滤输出。
 */
const SENSITIVE_DIRS = [".ssh", ".aws", ".gnupg", ".kube"];
const SENSITIVE_FILES = new Set([".git-credentials", ".npmrc", ".pypirc", ".netrc"]);
const SENSITIVE_ID = /^id_(?:rsa|ed25519|ecdsa|dsa)$/i;

export function isSensitivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  const base = parts.at(-1) ?? "";
  // .env / .env.local / .env.production；.env.example 也按敏感处理（宁可多问一次）
  if (base.startsWith(".env")) return true;
  if (SENSITIVE_FILES.has(base)) return true;
  if (SENSITIVE_ID.test(base)) return true;
  return parts.some((p) => SENSITIVE_DIRS.includes(p));
}

/** bash 命令里的敏感路径（`cat .env`、`--file=.ssh/id_rsa`）：按空白/引号切词后逐词判断 */
export function sensitivePathInCommand(command: string): boolean {
  const tokens = command
    .split(/[\s"'`]+/)
    .map((t) => (t.includes("=") ? t.slice(t.indexOf("=") + 1) : t))
    .map((t) => t.replace(/^[=<>|&;]+|[|&;,]+$/g, ""))
    .filter((t) => t !== "");
  return tokens.some((t) => isSensitivePath(t));
}

/** 权限引擎/工具层共用的最小参数面：read.path / grep.path|glob / glob.pattern / bash.command */
export function sensitivePathFromArgs(tool: string, args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  if (tool === "bash") {
    const command = (args as { command?: unknown }).command;
    return typeof command === "string" && sensitivePathInCommand(command);
  }
  if (tool !== "read" && tool !== "grep" && tool !== "glob") return false;
  const a = args as { path?: unknown; glob?: unknown; pattern?: unknown };
  const values = [a.path, a.glob, a.pattern].filter((v): v is string => typeof v === "string" && v !== "");
  return values.some(isSensitivePath);
}
