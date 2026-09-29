import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Windows git-bash 探测（自 bash.ts 外迁，N3E 行数治理）：
 * PATH 候选（过滤 WSL 启动器）→ git.exe 反推 → 常见安装位 → 探针验证。
 */

/**
 * 由 PATH 上的 git.exe 反推同级 bash（git 常把 \cmd 加入 PATH 而 \usr\bin 不在）：
 * <gitdir>\cmd\git.exe → <gitdir>\usr\bin\bash.exe / <gitdir>\bin\bash.exe。
 */
function bashDirsFromGitExe(dirs: string[], exists: (p: string) => boolean = existsSync): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    if (dir === "") continue;
    const lower = dir.toLowerCase();
    if (lower.startsWith("c:\\windows") || lower.includes("\\windows\\system32")) continue;
    if (!exists(join(dir.trim(), "git.exe"))) continue;
    const gitRoot = dirname(dir.trim());
    for (const sub of ["usr\\bin", "bin"]) {
      const candidate = join(gitRoot, sub, "bash.exe");
      if (exists(candidate)) {
        out.push(candidate);
      }
    }
  }
  return out;
}

function commonBashDirs(): string[] {
  const programDirs = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["LOCALAPPDATA"] !== undefined
      ? join(process.env["LOCALAPPDATA"], "Programs")
      : undefined,
  ].filter((d): d is string => d !== undefined);
  const out: string[] = [];
  for (const base of programDirs) {
    for (const sub of ["Git\\bin", "Git\\usr\\bin"]) {
      out.push(join(base, sub, "bash.exe"));
    }
  }
  return out;
}

/** 探针标记：候选 bash 必须能真正执行并回显 */
const BASH_PROBE_MARKER = "__kcode_bash_ok__";

async function probeBashWorks(bashPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const child = spawn(bashPath, ["-c", `echo ${BASH_PROBE_MARKER}`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolveProbe(false);
    }, 4000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveProbe(code === 0 && out.includes(BASH_PROBE_MARKER));
    });
  });
}

/**
 * Windows 上筛选 bash 候选路径：跳过 \Windows\ 目录（WSL 启动器）。
 * exists 可注入供测试；生产缺省 existsSync。
 */
export function pickBashCandidates(
  dirs: string[],
  exists: (p: string) => boolean = existsSync,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (dir === "") continue;
    const lower = dir.toLowerCase();
    if (lower.startsWith("c:\\windows") || lower.includes("\\windows\\system32")) continue;
    const candidate = join(dir.trim(), "bash.exe");
    if (seen.has(candidate) || !exists(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** 探测 Windows 上可用的 git-bash：PATH 候选（过滤 WSL）→ git.exe 反推 → 常见安装位 → 探针验证 */
export async function detectWindowsBash(): Promise<string | undefined> {
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  const candidates = [
    ...pickBashCandidates(pathDirs),
    ...bashDirsFromGitExe(pathDirs),
    ...commonBashDirs().filter((p) => existsSync(p)),
  ];
  for (const candidate of candidates) {
    if (await probeBashWorks(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
