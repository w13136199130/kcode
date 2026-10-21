import { describe, expect, it } from "vitest";
import type { SandboxRequest } from "@kcode/contracts";
import { mxcRequest } from "../src/backends/mxc.js";

const base: SandboxRequest = {
  command: "echo hi",
  cwd: "C:\\work\\project",
  shell: "powershell.exe",
  env: { PATH: "C:\\bin", KCODE_TEST: "1" },
  mode: "workspace-write",
  network: "deny",
  timeoutMs: 12_000,
};

describe("MXC request mapping（4-01）", () => {
  it("workspace-write 映射 readwritePaths，网络默认 deny，UI 禁止", () => {
    const req = mxcRequest(base);
    expect(req.filesystem).toMatchObject({ readwritePaths: ["C:\\work\\project"] });
    expect(req.filesystem).not.toHaveProperty("readonlyPaths");
    expect(req.network?.egress?.default).toBe("deny");
    expect(req.ui?.disable).toBe(true);
    expect(req.workingDirectory).toBe("C:\\work\\project");
    expect(req.timeoutMs).toBe(12_000);
    expect(req.environment).toEqual(base.env);
    expect(req.inheritDefaultEnvironment).toBe(false);
  });

  it("read-only 映射 readonlyPaths，不授予写", () => {
    const req = mxcRequest({ ...base, mode: "read-only" });
    expect(req.filesystem).toMatchObject({ readonlyPaths: ["C:\\work\\project"] });
    expect(req.filesystem).not.toHaveProperty("readwritePaths");
  });
});
