import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 剪贴板图片读取（N3C-4⑤ Ctrl+V 贴图）：终端不会把图片经 stdin 传来（Ctrl+V 的
 * 文本粘贴由终端自己处理），必须经系统 API 取剪贴板位图落盘为 PNG。
 * v1 仅 Windows（PowerShell + WinForms，STA 线程要求）；其他平台返回 null 走提示降级。
 * macOS 需要 pngpaste、Linux 需要 xclip——生态依赖不进默认路径，留后续按需接。
 */

/** 生成 PNG 落盘目标（按时间戳+随机段防重名） */
function targetFile(dir: string): string {
  return join(dir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
}

/** Windows：PowerShell 取剪贴板位图存 PNG；剪贴板无图片（exit 1）或其他失败都返回 null */
function readViaPowerShell(target: string): Promise<string | null> {
  // 单引号包裹路径；PowerShell 里目标路径作为字面量传入，不存在注入面（路径由本模块生成）
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "$img = [System.Windows.Forms.Clipboard]::GetImage(); " +
    `if ($img -ne $null) { $img.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 } else { exit 1 }`;
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      { windowsHide: true },
    );
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? target : null));
  });
}

/**
 * 读剪贴板图片到 PNG 文件；成功返回文件路径，无图片/平台不支持/读失败返回 null。
 * targetDir 由调用方给出（kcodeHome 下 tmp），文件由本模块命名。
 */
export async function readClipboardImageToFile(targetDir: string): Promise<string | null> {
  if (process.platform !== "win32") {
    return null; // 非 Windows：调用方给"用 --image 附加"提示
  }
  try {
    await mkdir(targetDir, { recursive: true });
  } catch {
    return null;
  }
  const target = targetFile(targetDir);
  return readViaPowerShell(target);
}
