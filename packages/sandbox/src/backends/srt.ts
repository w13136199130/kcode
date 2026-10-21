import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  SandboxAvailability,
  SandboxPort,
  SandboxRequest,
  SandboxResult,
} from "@kcode/contracts";
import { policyFor, toSrtConfig } from "../policy.js";

/**
 * Anthropic Sandbox Runtime (srt) Windows 适配器。
 *
 * 走 `srt` CLI 而不是库 API：库的 SandboxManager 在已有 persistent
 * write-root 的机器上会卡在 initialize ACL；CLI 的 `-c` 路径已验证可重复
 * 运行。settings/包装脚本落在临时目录，命令仍由用户选择的 shell 执行。
 */
const require = createRequire(import.meta.url);

function srtCliPath(): string {
  const pkgPath = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  return join(dirname(pkgPath), "dist", "cli.js");
}

function isBashShell(shell: string): boolean {
  return /bash(?:\.exe)?$/i.test(basename(shell));
}

function wrapperFor(shell: string, scriptPath: string): { name: string; content: string } {
  if (isBashShell(shell)) {
    return {
      name: "run.cmd",
      content: `@echo off\r\n"${shell}" "${scriptPath}"\r\nexit /b %ERRORLEVEL%\r\n`,
    };
  }
  return {
    name: "run.cmd",
    content: `@echo off\r\n"${shell}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\nexit /b %ERRORLEVEL%\r\n`,
  };
}

function killTree(pid: number): void {
  if (process.platform !== "win32") return;
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).unref();
  } catch {
    // Best effort; the srt wrapper owns its job object.
  }
}

/** 工作区属主可能是 Administrators；给 sandbox 用户注入 safe.directory，而不是改用户全局 git。 */
function gitRoot(cwd: string): string {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

export class SrtSandbox implements SandboxPort {
  readonly id = "srt" as const;
  #availability: Promise<SandboxAvailability> | undefined;

  available(): Promise<SandboxAvailability> {
    this.#availability ??= this.#probe();
    return this.#availability;
  }

  async #probe(): Promise<SandboxAvailability> {
    if (process.platform !== "win32") {
      return { available: false, backend: "srt", reason: "srt backend M1 仅支持 Windows" };
    }
    try {
      const mod = await import("@anthropic-ai/sandbox-runtime");
      if (!mod.SandboxManager.isSupportedPlatform()) {
        return { available: false, backend: "srt", reason: "srt 不支持当前平台" };
      }
      const status = await mod.checkWindowsSandboxStatusAsync({
        srtWin: mod.resolveSrtWin({ path: mod.VENDORED_SRT_WIN_EXE }),
      });
      if (!status.user.provisioned) {
        return {
          available: false,
          backend: "srt",
          reason: "srt Windows 沙箱未安装：npx @anthropic-ai/sandbox-runtime windows-install",
        };
      }
      return { available: true, backend: "srt" };
    } catch (err) {
      return {
        available: false,
        backend: "srt",
        reason: `srt 不可用：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    const dir = await mkdtemp(join(tmpdir(), "kcode-srt-"));
    try {
      const policy = policyFor(request);
      policy.allowRead = [dir];
      const settingsPath = join(dir, "settings.json");
      const settings = {
        ...toSrtConfig(policy),
        // Git dubious-ownership: the workspace can be owned by Administrators,
        // while the sandbox child runs as srt-sandbox. Let srt inject
        // GIT_CONFIG_* safe.directory for this command only.
        git: { safeDirectories: [gitRoot(request.cwd)] },
      };
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

      const isBash = isBashShell(request.shell);
      const scriptName = isBash ? "run.sh" : "run.ps1";
      const scriptPath = join(dir, scriptName);
      await writeFile(scriptPath, request.command, "utf8");
      const wrapper = wrapperFor(request.shell, scriptPath);
      const wrapperPath = join(dir, wrapper.name);
      await writeFile(wrapperPath, wrapper.content, "utf8");

      const cli = srtCliPath();
      return await new Promise<SandboxResult>((resolve) => {
        const child = spawn(process.execPath, [cli, "--settings", settingsPath, "-c", wrapperPath], {
          cwd: request.cwd,
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer =
          request.timeoutMs !== undefined
            ? setTimeout(() => {
                timedOut = true;
                if (child.pid !== undefined) killTree(child.pid);
              }, request.timeoutMs)
            : undefined;
        const onAbort = (): void => {
          if (child.pid !== undefined) killTree(child.pid);
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
          if (timer !== undefined) clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          resolve({
            exitCode: 1,
            stdout,
            stderr: `${stderr}\n${err.message}`.trim(),
            timedOut,
            sandboxed: false,
            backend: "srt",
          });
        });
        child.on("close", (code) => {
          if (timer !== undefined) clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          resolve({
            exitCode: code ?? -1,
            stdout,
            stderr,
            timedOut,
            sandboxed: true,
            backend: "srt",
          });
        });
      });
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `srt 启动失败：${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
        sandboxed: false,
        backend: "srt",
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
