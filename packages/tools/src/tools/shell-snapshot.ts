/** 工作目录打点：随机 nonce 后缀防与用户输出巧合碰撞 */
const SHELL_SNAPSHOT_PREFIX = "__kcode_pwd_";

/**
 * 前台命令尾部追加打点：命令结束后回传当前目录，供下次调用恢复 cwd。
 * bash 侧用 cygpath -w 把 $PWD 转成 Win32 路径；PowerShell 侧退出码沿用外层 exit。
 */
export function markCommandForSnapshot(
  shellName: "bash" | "powershell",
  command: string,
  nonce: string,
): string {
  if (shellName === "powershell") {
    return `${command}; Write-Output "${SHELL_SNAPSHOT_PREFIX}${nonce}:$pwd"`;
  }
  const reportPwd = `"$(cygpath -w "$PWD" 2>/dev/null || printf '%s' "$PWD")"`;
  return `${command}; __kcode_rc=$?; printf '\\n${SHELL_SNAPSHOT_PREFIX}${nonce}:%s\\n' ${reportPwd}; exit $__kcode_rc`;
}

/** 从输出中提取打点行：返回回传目录与剥除打点行后的输出（取最后一次出现） */
export function extractShellSnapshot(
  output: string,
  nonce: string,
): { cwd?: string; output: string } {
  const token = `${SHELL_SNAPSHOT_PREFIX}${nonce}:`;
  const idx = output.lastIndexOf(token);
  if (idx === -1) {
    return { output };
  }
  const lineEnd = output.indexOf("\n", idx);
  const cwd = (
    lineEnd === -1 ? output.slice(idx + token.length) : output.slice(idx + token.length, lineEnd)
  ).replace(/\r$/, "");
  const lineStart = output.lastIndexOf("\n", idx - 1);
  const before = lineStart === -1 ? "" : output.slice(0, lineStart);
  const after = lineEnd === -1 ? "" : output.slice(lineEnd + 1);
  return { cwd: cwd.length > 0 ? cwd : undefined, output: before + after };
}
