import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolPermission } from "@kcode/contracts";
import { isSafeBashCommand, ModePermissionEngine } from "../src/index.js";

const bashDef: ToolDefinition = {
  name: "bash",
  description: "",
  parameters: { type: "object" },
  readOnly: false,
  permission: { default: "ask" } satisfies ToolPermission,
};

describe("isSafeBashCommand（安全命令白名单）", () => {
  it("只读/查询命令直跑", () => {
    for (const cmd of [
      "ls", "ls -la src", "pwd", "cat package.json", "head -20 x.log", "tail -f 不算？不：tail -f 只读",
      "wc -l a.ts", "grep -n todo src", "rg pattern", "find . -name *.ts", "tree -L 2",
      "git status", "git log --oneline -5", "git diff", "git show HEAD", "git branch",
      "git stash list", "echo hello", "which node", "df -h",
    ]) {
      expect(isSafeBashCommand(cmd), cmd).toBe(true);
    }
  });

  it("副作用/未知命令不直跑", () => {
    for (const cmd of [
      "rm -rf /", "mv a b", "cp a b", "touch x", "mkdir d", "npm install", "pnpm test",
      "git push", "git checkout -b x", "git branch -D main", "git stash drop", "git tag -d v1",
      "find . -name x -delete", "find . -exec rm {} \\;",
      "node -e anything", "curl http://x", "chmod +x s", "kcode key add",
    ]) {
      expect(isSafeBashCommand(cmd), cmd).toBe(false);
    }
  });

  it("含控制结构一律不直跑——包括引号内的（不解析引号，宁可误问）", () => {
    for (const cmd of [
      "ls && rm -rf /", "ls; rm x", "cat a | sh", "echo hi > file", "ls >> log",
      "echo $(rm -rf /)", "echo `rm x`", 'git status && git push', "cat a<b",
      'echo "a;b"', "ls | wc -l",
    ]) {
      expect(isSafeBashCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("ModePermissionEngine × 安全命令门", () => {
  it("default/acceptEdits 档：安全 bash 直跑、危险 bash 照旧 ask", async () => {
    const engine = new ModePermissionEngine("default");
    expect(await engine.decide(bashDef, { command: "ls -la" })).toBe("allow");
    expect(await engine.decide(bashDef, { command: "rm -rf build" })).toBe("ask");
    expect(await engine.decide(bashDef, { command: "git status" })).toBe("allow");
    expect(await engine.decide(bashDef, { command: "git push" })).toBe("ask");
    const edits = new ModePermissionEngine("acceptEdits");
    expect(await edits.decide(bashDef, { command: "grep -r todo src" })).toBe("allow");
    expect(await edits.decide(bashDef, { command: "pnpm install" })).toBe("ask");
  });

  it("plan 档不走此门：bash 一律 deny（只读研究姿态）", async () => {
    const engine = new ModePermissionEngine("plan");
    expect(await engine.decide(bashDef, { command: "ls" })).toBe("deny");
    expect(await engine.decide(bashDef, { command: "rm -rf x" })).toBe("deny");
  });

  it("非 bash 工具不受影响；声明 allow/deny 的不被门改写", async () => {
    const engine = new ModePermissionEngine("default");
    const read: ToolDefinition = { ...bashDef, name: "read", readOnly: true, permission: { default: "allow" } };
    expect(await engine.decide(read, {})).toBe("allow");
    // bash 声明 deny（假想场景）：门不升格
    const denied: ToolDefinition = { ...bashDef, permission: { default: "deny" } };
    expect(await engine.decide(denied, { command: "ls" })).toBe("deny");
  });
});
