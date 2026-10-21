import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxRequest } from "@kcode/contracts";

/**
 * 与 vendor 无关的沙箱策略。srt/MXC adapter 各自把它翻译成自己的配置，
 * 这样 Router/tools 不需要知道 srt settings 或 MXC ContainerRequest。
 */
export interface SandboxPolicy {
  allowRead: string[];
  allowWrite: string[];
  denyRead: string[];
  allowedHosts: string[];
}

/** 高价值凭据/配置：默认不授予沙箱命令读取；不存在的路径跳过。 */
export function sensitiveReadPaths(home: string = homedir()): string[] {
  const candidates = [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".azure"),
    join(home, ".config", "gcloud"),
    join(home, ".kube"),
    join(home, ".kcode"),
    join(home, ".git-credentials"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
    join(home, ".docker", "config.json"),
  ];
  return candidates.filter((path) => existsSync(path));
}

export function denyReadFor(home: string = homedir()): string[] {
  const override = process.env["KCODE_SANDBOX_DENY_READ"];
  if (override === undefined || override.trim() === "") return [];
  if (override === "default") return sensitiveReadPaths(home);
  return override.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function policyFor(request: SandboxRequest, home: string = homedir()): SandboxPolicy {
  return {
    allowRead: [],
    allowWrite: request.mode === "workspace-write" ? [request.cwd] : [],
    denyRead: denyReadFor(home),
    allowedHosts: request.network === "allowlist" ? (request.allowedHosts ?? []) : [],
  };
}

/** srt 的配置形状由这里唯一生成；adapter 之外不出现 srt 字段。 */
export function toSrtConfig(policy: SandboxPolicy): {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: { allowRead: string[]; denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
} {
  return {
    network: { allowedDomains: policy.allowedHosts, deniedDomains: [] },
    filesystem: {
      allowRead: policy.allowRead,
      denyRead: policy.denyRead,
      allowWrite: policy.allowWrite,
      denyWrite: [],
    },
  };
}
