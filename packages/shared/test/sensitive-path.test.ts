import { describe, expect, it } from "vitest";
import { isSensitivePath, sensitivePathFromArgs } from "../src/sensitive-path.js";

describe("2-14 敏感路径判定", () => {
  it(".env* / .ssh / .aws / id_* / .git-credentials 命中", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".env.example",
      "config/.env.production",
      "C:\\Users\\me\\.ssh\\id_rsa",
      "/home/me/.aws/credentials",
      ".git-credentials",
      "keys/id_ed25519",
    ]) {
      expect(isSensitivePath(path)).toBe(true);
    }
  });

  it("普通源码/配置/示例不误报", () => {
    for (const path of ["src/index.ts", "docs/ssh.md", "config/app.yaml", "id_rsa.md"]) {
      expect(isSensitivePath(path)).toBe(false);
    }
  });

  it("只对 read/grep/glob 的路径参数生效", () => {
    expect(sensitivePathFromArgs("read", { path: ".env" })).toBe(true);
    expect(sensitivePathFromArgs("grep", { pattern: "KEY", glob: "**/.env*" })).toBe(true);
    expect(sensitivePathFromArgs("glob", { pattern: "**/.ssh/**" })).toBe(true);
    expect(sensitivePathFromArgs("bash", { command: "cat .env" })).toBe(true);
    expect(sensitivePathFromArgs("bash", { command: "cat --file=.ssh/id_rsa" })).toBe(true);
    expect(sensitivePathFromArgs("bash", { command: "cat src/index.ts" })).toBe(false);
    expect(sensitivePathFromArgs("read", { path: "src/index.ts" })).toBe(false);
  });
});
