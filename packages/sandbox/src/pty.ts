import type { SandboxMode } from "@kcode/contracts";
import { mxcRequest } from "./backends/mxc.js";

export interface SandboxPtyOptions {
  /** mxc = 受 MXC 保护的 PTY；plain = 普通 PTY（明确不受保护） */
  backend: "mxc" | "plain";
  cwd: string;
  shellFile: string;
  shellName: "bash" | "powershell";
  mode: SandboxMode;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

export interface SandboxPtySession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (chunk: string) => void): () => void;
  onExit(callback: (code: number) => void): () => void;
}

function interactiveShellCommand(opts: SandboxPtyOptions): string {
  return opts.shellName === "bash"
    ? `"${opts.shellFile}" -i`
    : `"${opts.shellFile}" -NoLogo`;
}

export async function startSandboxPty(opts: SandboxPtyOptions): Promise<SandboxPtySession> {
  if (opts.backend === "mxc") {
    return startMxcPty(opts);
  }
  return startPlainPty(opts);
}

async function startMxcPty(opts: SandboxPtyOptions): Promise<SandboxPtySession> {
  const mod = await import("@microsoft/mxc-sdk/v1");
  const terminal = await mod.spawnWithPty(
    mxcRequest({
      command: interactiveShellCommand(opts),
      cwd: opts.cwd,
      shell: opts.shellFile,
      env: opts.env ?? process.env,
      mode: opts.mode,
      network: "deny",
    }),
    { size: { rows: Math.max(5, opts.rows), columns: Math.max(20, opts.cols) } },
  );
  const cleanups: (() => void)[] = [];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    terminal.dispose();
  };
  cleanups.push(() => terminal.kill());
  return {
    write: (data) => terminal.input.write(data),
    resize: (cols, rows) => terminal.resize({ rows: Math.max(5, rows), columns: Math.max(20, cols) }),
    kill: () => {
      terminal.kill();
      dispose();
    },
    onData: (callback) => {
      const handler = (chunk: Buffer | string): void => callback(chunk.toString());
      terminal.output.on("data", handler);
      const off = (): void => {
        terminal.output.off("data", handler);
      };
      cleanups.push(off);
      return off;
    },
    onExit: (callback) => {
      let active = true;
      void terminal
        .wait()
        .then(({ exitCode }) => {
          if (active) callback(exitCode);
        })
        .catch(() => undefined)
        .finally(dispose);
      return () => {
        active = false;
      };
    },
  };
}

async function startPlainPty(opts: SandboxPtyOptions): Promise<SandboxPtySession> {
  const pty = await import("@lydell/node-pty");
  const child = pty.spawn(opts.shellFile, [opts.shellName === "bash" ? "-i" : "-NoLogo"], {
    name: "xterm-256color",
    cols: Math.max(20, opts.cols),
    rows: Math.max(5, opts.rows),
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    useConpty: false,
  });
  return {
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(Math.max(20, cols), Math.max(5, rows)),
    kill: () => child.kill(),
    onData: (callback) => {
      const disposable = child.onData(callback);
      return () => disposable.dispose();
    },
    onExit: (callback) => {
      const disposable = child.onExit(({ exitCode }) => callback(exitCode));
      return () => disposable.dispose();
    },
  };
}
