import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PermissionEngine, ToolDefinition } from "@kcode/contracts";
import {
  PolicyPermissionEngine,
  loadPolicy,
  matchCommandPrefix,
  matchPolicyRule,
  type PolicyRule,
} from "../src/permissions/policy.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectWithPolicy(doc: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kcode-policy-"));
  dirs.push(dir);
  await mkdir(join(dir, ".kcode"), { recursive: true });
  await writeFile(join(dir, ".kcode", "policy.json"), JSON.stringify(doc), "utf8");
  return dir;
}

const tool = (name: string): ToolDefinition =>
  ({ name, description: "", parameters: {}, readOnly: false }) as ToolDefinition;

const ALLOW: PermissionEngine = { decide: () => "allow" };
const ASK: PermissionEngine = { decide: () => "ask" };
const DENY: PermissionEngine = { decide: () => "deny" };

const RULES: PolicyRule[] = [
  {
    tool: "bash",
    commandPrefix: ["rm -rf /", "git push --force", "del /s", "Remove-Item -Recurse"],
    decision: "deny",
    priority: 100,
  },
  { tool: "bash", commandPrefix: ["git push"], decision: "allow", priority: 1 },
  { tool: "write", pathPrefix: [".env"], decision: "ask", priority: 50 },
];

describe("4-02 项目策略文件", () => {
  it("加载 JSON：规则、优先级、路径前缀", async () => {
    const dir = await projectWithPolicy({
      version: 1,
      rules: [
        { tool: "bash", commandPrefix: ["rm -rf /", "git push --force"], decision: "deny", priority: 100 },
        { tool: "write", pathPrefix: [".env"], decision: "ask", priority: 50 },
        { tool: "bash", commandPrefix: "npm test", decision: "allow", priority: 10 },
      ],
    });
    const policy = await loadPolicy(dir, true);
    expect(policy.errors).toEqual([]);
    expect(policy.rules).toHaveLength(3);
    expect(policy.rules[0]?.commandPrefix).toEqual(["rm -rf /", "git push --force"]);
  });

  it("deny/ask/allow 语义：deny 覆盖模式；ask 只收紧；allow 只降 ask", async () => {
    const policy = { rules: RULES, errors: [] as string[] };
    const deny = new PolicyPermissionEngine(DENY, policy);
    const allow = new PolicyPermissionEngine(ALLOW, policy);
    const ask = new PolicyPermissionEngine(ASK, policy);

    // deny 覆盖 fullAccess 的 allow
    expect(await allow.decide(tool("bash"), { command: "rm -rf /" })).toBe("deny");
    // 复合命令/包装命令也命中
    expect(await allow.decide(tool("bash"), { command: "echo ok && rm -rf /tmp" })).toBe("deny");
    expect(await allow.decide(tool("bash"), { command: "sudo -u root rm -rf /" })).toBe("deny");
    // ask 把 allow 抬回确认，但不覆盖 deny
    expect(await allow.decide(tool("bash"), { command: "git push --force" })).toBe("deny");
    expect(await allow.decide(tool("write"), { path: ".env" })).toBe("ask");
    expect(await deny.decide(tool("write"), { path: ".env" })).toBe("deny");
    // allow 只把 ask 降为放行
    expect(await ask.decide(tool("bash"), { command: "git push origin main" })).toBe("allow");
    expect(await deny.decide(tool("bash"), { command: "git push origin main" })).toBe("deny");
  });

  it("同优先级 deny 决胜；priority 高者先", async () => {
    const tie = {
      rules: [
        { tool: "bash", commandPrefix: ["npm"], decision: "allow", priority: 0 },
        { tool: "bash", commandPrefix: ["npm"], decision: "deny", priority: 0 },
      ] as PolicyRule[],
      errors: [],
    };
    expect(await new PolicyPermissionEngine(ASK, tie).decide(tool("bash"), { command: "npm test" })).toBe("deny");

    const priority = {
      rules: [
        { tool: "bash", commandPrefix: ["git push --force"], decision: "deny", priority: 100 },
        { tool: "bash", commandPrefix: ["git push"], decision: "allow", priority: 1 },
      ] as PolicyRule[],
      errors: [],
    };
    expect(
      await new PolicyPermissionEngine(ASK, priority).decide(tool("bash"), { command: "git push --force" }),
    ).toBe("deny");
    expect(
      await new PolicyPermissionEngine(ASK, priority).decide(tool("bash"), { command: "git push origin main" }),
    ).toBe("allow");
  });

  it("命令前缀：bash/PowerShell 双语法、分段、包装剥离；不做子串误匹配", () => {
    expect(matchCommandPrefix("rm -rf /", "rm -rf /")).toBe(true);
    expect(matchCommandPrefix("rm -rf /tmp", "rm -rf /")).toBe(true);
    expect(matchCommandPrefix("del /s /q C:\\tmp", "del /s")).toBe(true);
    expect(matchCommandPrefix("Remove-Item -Recurse -Force .\\x", "Remove-Item -Recurse")).toBe(true);
    expect(matchCommandPrefix("echo ok; git push --force", "git push --force")).toBe(true);
    expect(matchCommandPrefix("sudo -u root rm -rf /", "rm -rf /")).toBe(true);
    expect(matchCommandPrefix("echo rm -rf /", "rm -rf /")).toBe(false);
  });

  it("未信任项目：deny/ask 保留，allow 被忽略", async () => {
    const dir = await projectWithPolicy({
      version: 1,
      rules: [
        { tool: "bash", commandPrefix: "rm -rf /", decision: "deny" },
        { tool: "bash", commandPrefix: "npm test", decision: "allow" },
      ],
    });
    const trusted = await loadPolicy(dir, true);
    const untrusted = await loadPolicy(dir, false);
    expect(trusted.rules).toHaveLength(2);
    expect(untrusted.rules).toHaveLength(1);
    expect(untrusted.ignoredAllow).toBe(1);
    expect(await new PolicyPermissionEngine(ASK, untrusted).decide(tool("bash"), { command: "npm test" })).toBe("ask");
  });

  it("损坏/非法策略 fail-closed；不存在 = 空策略", async () => {
    const bad = await projectWithPolicy({ version: 2, rules: [] });
    const result = await loadPolicy(bad, true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(await new PolicyPermissionEngine(ALLOW, result).decide(tool("read"), { path: "a.txt" })).toBe("deny");

    const emptyDir = await mkdtemp(join(tmpdir(), "kcode-policy-empty-"));
    dirs.push(emptyDir);
    const empty = await loadPolicy(emptyDir, false);
    expect(empty.exists).toBe(false);
    expect(empty.errors).toEqual([]);
  });

  it("matchPolicyRule 要求 tool 与 command/path 同时命中", () => {
    const rule: PolicyRule = {
      tool: "bash",
      commandPrefix: ["rm"],
      pathPrefix: ["src"],
      decision: "deny",
      priority: 0,
    };
    expect(matchPolicyRule(rule, "bash", { command: "rm -rf /", path: "src/a" })).toBe(true);
    expect(matchPolicyRule(rule, "write", { command: "rm -rf /", path: "src/a" })).toBe(false);
    expect(matchPolicyRule(rule, "bash", { command: "rm -rf /", path: "other" })).toBe(false);
  });
});
