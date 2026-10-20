import { spawnSync } from "node:child_process";

/**
 * 3-22：把文本放进系统剪贴板（工具详情 `c` 复制）。
 * 不引入原生依赖：Windows 走 PowerShell Set-Clipboard（显式 UTF-8 输入，避免中文乱码），
 * macOS 走 pbcopy，Linux 依次尝试 wl-copy / xclip / xsel。全部失败返回 false（界面提示替代路径）。
 */
export function copyTextToClipboard(text: string): boolean {
  const attempt = (command: string, args: string[]): boolean => {
    try {
      const result = spawnSync(command, args, {
        input: text,
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      return result.error === undefined && result.status === 0;
    } catch {
      return false;
    }
  };
  if (process.platform === "win32") {
    return attempt("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::InputEncoding=[Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t",
    ]);
  }
  if (process.platform === "darwin") {
    return attempt("pbcopy", []);
  }
  return attempt("wl-copy", []) || attempt("xclip", ["-selection", "clipboard"]) || attempt("xsel", ["--clipboard", "--input"]);
}
