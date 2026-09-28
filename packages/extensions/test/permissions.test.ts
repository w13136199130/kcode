import { describe, expect, it } from "vitest";
import type {
  PermissionDecision,
  PermissionEngine,
  ToolDefinition,
  ToolPermission,
} from "@kcode/contracts";
import {
  AutomationPermissionEngine,
  MODE_FALLBACK,
  ModePermissionEngine,
  MutablePermissionEngine,
  RuleBasedPermissionEngine,
  matchTool,
} from "../src/index.js";

const def = (name: string, permission?: ToolPermission, readOnly = false): ToolDefinition => ({
  name,
  description: "",
  parameters: { type: "object" },
  readOnly,
  ...(permission !== undefined ? { permission } : {}),
});

/** 内置工具的 ToolEntry 声明缩影（与 tools 包实际声明同语义，N2-3） */
const READ = def("read", { default: "allow" }, true);
const WRITE = def("write", { default: "ask", acceptEdits: "allow" });
const BASH = def("bash", { default: "ask" });
const MCP_TOOL = def("mcp__srv__tool"); // 未声明 → 档位回退
const UNKNOWN = def("unknown-tool");

describe("matchTool 模式匹配", () => {
  it("精确 / 通配 / 插件命名空间", () => {
    expect(matchTool("write", "write")).toBe(true);
    expect(matchTool("wr*", "write")).toBe(true);
    expect(matchTool("*", "anything")).toBe(true);
    expect(matchTool("plugin:code-review::*", "plugin:code-review::review")).toBe(true);
    expect(matchTool("mcp__*", "mcp__server__tool")).toBe(true);
    expect(matchTool("write", "edit")).toBe(false);
    expect(matchTool("writ", "write")).toBe(false);
  });
});

describe("ModePermissionEngine（N2-3 声明驱动，取代四份模式名单）", () => {
  it("default：声明的只读放行、写/命令询问", async () => {
    const engine = new ModePermissionEngine("default");
    expect(await engine.decide(READ, {})).toBe("allow");
    expect(await engine.decide(WRITE, {})).toBe("ask");
    expect(await engine.decide(BASH, {})).toBe("ask");
  });

  it("plan：readOnly 推导只读放行、副作用拒绝；显式 plan 声明优先", async () => {
    const engine = new ModePermissionEngine("plan");
    expect(await engine.decide(READ, {})).toBe("allow");
    expect(await engine.decide(WRITE, {})).toBe("deny");
    expect(await engine.decide(BASH, {})).toBe("deny");
    // 显式 plan 声明覆盖 readOnly 推导（如只读但仍要询问的场合）
    expect(await engine.decide(def("sensitive", { default: "allow", plan: "ask" }, true), {})).toBe("ask");
  });

  it("acceptEdits：编辑放行、命令仍询问（acceptEdits 缺省同 default）", async () => {
    const engine = new ModePermissionEngine("acceptEdits");
    expect(await engine.decide(WRITE, {})).toBe("allow");
    expect(await engine.decide(BASH, {})).toBe("ask");
    expect(await engine.decide(READ, {})).toBe("allow");
  });

  it("fullAccess：恒放行（无需声明）", async () => {
    const engine = new ModePermissionEngine("fullAccess");
    expect(await engine.decide(BASH, {})).toBe("allow");
    expect(await engine.decide(UNKNOWN, {})).toBe("allow");
  });

  it("未声明工具（MCP/插件/未知）按 MODE_FALLBACK 回退：plan deny、default/acceptEdits ask", async () => {
    expect(MODE_FALLBACK).toEqual({
      plan: "deny",
      default: "ask",
      acceptEdits: "ask",
      fullAccess: "allow",
    });
    expect(await new ModePermissionEngine("plan").decide(MCP_TOOL, {})).toBe("deny");
    expect(await new ModePermissionEngine("default").decide(MCP_TOOL, {})).toBe("ask");
    expect(await new ModePermissionEngine("acceptEdits").decide(UNKNOWN, {})).toBe("ask");
  });

  it("规则引擎仍可用于显式覆盖（会话放行/项目持久放行按名匹配）", async () => {
    const engine = new RuleBasedPermissionEngine({
      rules: [
        { match: "*", decision: "allow" },
        { match: "write", decision: "deny" },
      ],
    });
    expect(await engine.decide(WRITE, {})).toBe("allow"); // 首条命中生效
  });
});

describe("MutablePermissionEngine（计划模式切换，§1.1 A 域）", () => {
  it("运行期在默认/只读姿态间切换", async () => {
    const engine = new MutablePermissionEngine(new ModePermissionEngine("default"));
    expect(await engine.decide(WRITE, {})).toBe("ask");
    engine.set(new ModePermissionEngine("plan"));
    expect(await engine.decide(WRITE, {})).toBe("deny");
    expect(await engine.decide(READ, {})).toBe("allow");
    engine.set(new ModePermissionEngine("default"));
    expect(await engine.decide(WRITE, {})).toBe("ask");
  });

  it("grant 后同工具放行；切档保留、切回 plan 清空", async () => {
    const engine = new MutablePermissionEngine(new ModePermissionEngine("default"));
    expect(await engine.decide(BASH, {})).toBe("ask");
    engine.grant("bash");
    expect(await engine.decide(BASH, {})).toBe("allow");
    expect(await engine.decide(WRITE, {})).toBe("ask");
    // 切到 acceptEdits 再切回：会话级放行仍生效
    engine.set(new ModePermissionEngine("acceptEdits"));
    engine.set(new ModePermissionEngine("default"));
    expect(await engine.decide(BASH, {})).toBe("allow");
    // 切入 plan：放行清空，只读姿态不被打穿
    engine.set(new ModePermissionEngine("plan"));
    engine.clearGrants();
    expect(await engine.decide(BASH, {})).toBe("deny");
  });
});

describe("automation 装饰器（§5.5）", () => {
  const askAlways: PermissionEngine = {
    decide: async (): Promise<PermissionDecision> => "ask",
  };

  it("ask 降级为 deny，allow/deny 原样透传", async () => {
    const auto = new AutomationPermissionEngine(askAlways);
    expect(await auto.decide(WRITE, {})).toBe("deny");
    const pass: PermissionEngine = {
      decide: async (): Promise<PermissionDecision> => "allow",
    };
    const wrapped = new AutomationPermissionEngine(pass);
    expect(await wrapped.decide(READ, {})).toBe("allow");
  });
});
