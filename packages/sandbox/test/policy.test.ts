import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxRequest } from "@kcode/contracts";
import { policyFor, sensitiveReadPaths, toSrtConfig } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const request = (mode: "read-only" | "workspace-write"): SandboxRequest => ({
  command: "echo hi",
  cwd: "C:\\work\\project",
  shell: "bash",
  env: {},
  mode,
  network: "deny",
});

describe("sandbox policy（4-01）", () => {
  it("workspace-write 只授予 cwd；read-only 不授予写；denyRead 默认不启用", () => {
    expect(policyFor(request("workspace-write"), "C:\\Users\\u").allowWrite).toEqual(["C:\\work\\project"]);
    expect(policyFor(request("read-only"), "C:\\Users\\u").allowWrite).toEqual([]);
    expect(policyFor(request("workspace-write"), "C:\\Users\\u").denyRead).toEqual([]);
  });

  it("敏感凭据目录存在时进入 denyRead；不存在不虚构", async () => {
    const home = await mkdtemp(join(tmpdir(), "kcode-sandbox-policy-"));
    dirs.push(home);
    await mkdir(join(home, ".ssh"), { recursive: true });
    await writeFile(join(home, ".netrc"), "machine x", "utf8");
    const paths = sensitiveReadPaths(home);
    expect(paths).toContain(join(home, ".ssh"));
    expect(paths).toContain(join(home, ".netrc"));
    expect(paths).not.toContain(join(home, ".aws"));
  });

  it("toSrtConfig：网络默认 deny；allowlist 才填 allowedDomains", () => {
    const deny = toSrtConfig({
      allowRead: [],
      allowWrite: ["C:\\w"],
      denyRead: ["C:\\Users\\u\\.ssh"],
      allowedHosts: [],
    });
    expect(deny.network.allowedDomains).toEqual([]);
    expect(deny.filesystem.allowWrite).toEqual(["C:\\w"]);
    expect(deny.filesystem.denyRead).toEqual(["C:\\Users\\u\\.ssh"]);

    const allow = toSrtConfig({ allowRead: [], allowWrite: [], denyRead: [], allowedHosts: ["api.deepseek.com"] });
    expect(allow.network.allowedDomains).toEqual(["api.deepseek.com"]);
  });
});
