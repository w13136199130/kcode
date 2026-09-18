import { describe, expect, it } from "vitest";
import type {
  PermissionDecision,
  PermissionEngine,
  PermissionRule,
  ToolDefinition,
} from "@kcode/contracts";
import {
  AutomationPermissionEngine,
  DEFAULT_RULES,
  MutablePermissionEngine,
  READONLY_RULES,
  RuleBasedPermissionEngine,
  YOLO_RULES,
  matchTool,
} from "../src/index.js";

const def = (name: string): ToolDefinition => ({
  name,
  description: "",
  parameters: { type: "object" },
  readOnly: false,
});

const engineOf = (rules: PermissionRule[]): RuleBasedPermissionEngine =>
  new RuleBasedPermissionEngine({ rules });

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

describe("预设语义（§7）", () => {
  it("readonly：读放行、写拒绝", async () => {
    const engine = engineOf(READONLY_RULES);
    expect(await engine.decide(def("read"), {})).toBe("allow");
    expect(await engine.decide(def("write"), {})).toBe("deny");
  });

  it("default：读放行、写/命令询问、未知拒绝", async () => {
    const engine = engineOf(DEFAULT_RULES);
    expect(await engine.decide(def("grep"), {})).toBe("allow");
    expect(await engine.decide(def("write"), {})).toBe("ask");
    expect(await engine.decide(def("edit"), {})).toBe("ask");
    expect(await engine.decide(def("bash"), {})).toBe("ask");
    expect(await engine.decide(def("unknown-tool"), {})).toBe("deny");
  });

  it("yolo：全放行", async () => {
    const engine = engineOf(YOLO_RULES);
    expect(await engine.decide(def("write"), {})).toBe("allow");
    expect(await engine.decide(def("anything"), {})).toBe("allow");
  });

  it("规则按序匹配，首条命中生效", async () => {
    const engine = new RuleBasedPermissionEngine({
      rules: [
        { match: "*", decision: "allow" },
        { match: "write", decision: "deny" },
      ],
    });
    expect(await engine.decide(def("write"), {})).toBe("allow");
  });
});

describe("MutablePermissionEngine（计划模式切换，§1.1 A 域）", () => {
  it("运行期在默认/只读姿态间切换", async () => {
    const engine = new MutablePermissionEngine(engineOf(DEFAULT_RULES));
    expect(await engine.decide(def("write"), {})).toBe("ask");
    engine.set(engineOf(READONLY_RULES));
    expect(await engine.decide(def("write"), {})).toBe("deny");
    expect(await engine.decide(def("read"), {})).toBe("allow");
    engine.set(engineOf(DEFAULT_RULES));
    expect(await engine.decide(def("write"), {})).toBe("ask");
  });
});

describe("automation 装饰器（§5.5）", () => {
  const askAlways: PermissionEngine = {
    decide: async (): Promise<PermissionDecision> => "ask",
  };

  it("ask 降级为 deny，allow/deny 原样透传", async () => {
    const auto = new AutomationPermissionEngine(askAlways);
    expect(await auto.decide(def("write"), {})).toBe("deny");
    const pass: PermissionEngine = {
      decide: async (): Promise<PermissionDecision> => "allow",
    };
    const wrapped = new AutomationPermissionEngine(pass);
    expect(await wrapped.decide(def("read"), {})).toBe("allow");
  });
});
