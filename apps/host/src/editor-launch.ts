import { spawn, spawnSync } from "node:child_process";

/**
 * S1-1（F5）：在编辑器中打开工作区目录。
 * 编辑器解析：KCODE_EDITOR > EDITOR > code（VS Code）。先探测可用性（--version），
 * 再 detached 启动——探测失败抛出可读错误（renderer 弹窗），不在后台静默失败。
 */
export function openInEditor(path: string): { ok: true; command: string } {
  const editor = process.env["KCODE_EDITOR"] ?? process.env["EDITOR"] ?? "code";
  const shell = process.platform === "win32"; // Windows 上 code 实为 code.cmd，须经 shell 解析
  const probe = spawnSync(editor, ["--version"], { shell, encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(`未找到可用的编辑器「${editor}」——可安装 VS Code，或设置 KCODE_EDITOR 指向你的编辑器`);
  }
  const child = spawn(editor, shell ? [`"${path}"`] : [path], { shell, detached: true, stdio: "ignore" });
  child.unref();
  return { ok: true, command: editor };
}
