import { describe, expect, it } from "vitest";
import {
  formatGrantPattern,
  grantSubject,
  matchGrantContent,
  matchGrantPattern,
  parseGrantPattern,
  suggestGrant,
} from "../src/index.js";

/**
 * N3I-5 持久放行参数级粒度：content 三档匹配 + 建议规则生成
 * （bash 稳定子命令前缀 / edit·write 目录前缀 / 危险与可疑只给整串精确）。
 */

describe("matchGrantContent（三档匹配）", () => {
  it("前缀:* 词边界——命中前缀整体与前缀+空格，不命中前缀的子串", () => {
    expect(matchGrantContent("npm install:*", "npm install")).toBe(true);
    expect(matchGrantContent("npm install:*", "npm install --save-dev vitest")).toBe(true);
    expect(matchGrantContent("npm install:*", "npm installx")).toBe(false);
    expect(matchGrantContent("npm:*", "npmx")).toBe(false);
  });

  it("通配（非 :* 结尾）全锚定；整串精确", () => {
    expect(matchGrantContent("src/legacy/*", "src/legacy/a.ts")).toBe(true);
    expect(matchGrantContent("src/legacy/*", "src/legacyx/a.ts")).toBe(false);
    expect(matchGrantContent("git push origin main", "git push origin main")).toBe(true);
    expect(matchGrantContent("git push origin main", "git push origin main2")).toBe(false);
  });
});

describe("matchGrantPattern（工具名 + 主体）", () => {
  it("content 缺省 = 整工具（任意参数）；有 content 需主体命中", () => {
    expect(matchGrantPattern({ tool: "bash" }, "bash", "rm -rf /")).toBe(true);
    expect(matchGrantPattern({ tool: "bash", content: "npm:*" }, "bash", "npm test")).toBe(true);
    expect(matchGrantPattern({ tool: "bash", content: "npm:*" }, "bash", "rm -rf /")).toBe(false);
    expect(matchGrantPattern({ tool: "bash", content: "npm:*" }, "edit", "npm test")).toBe(false);
    expect(matchGrantPattern({ tool: "bash", content: "npm:*" }, "bash", undefined)).toBe(false);
  });
});

describe("suggestGrant（建议规则）", () => {
  it("bash 简单命令：首 1-2 token 稳定前缀（第二 token 非旗标并入）", () => {
    expect(suggestGrant({ tool: "bash", args: { command: "npm install" } })).toEqual({
      tool: "bash",
      content: "npm install:*",
    });
    expect(suggestGrant({ tool: "bash", args: { command: "git status" } })).toEqual({
      tool: "bash",
      content: "git status:*",
    });
    // 第二 token 是旗标：只取首 token
    expect(suggestGrant({ tool: "bash", args: { command: "rg --hidden -n foo" } })).toEqual({
      tool: "bash",
      content: "rg:*",
    });
  });

  it("复合命令：统一前缀 → 前缀规则；不统一/含危险段 → 整串精确", () => {
    // 两段前缀同为 npm install → 统一，给前缀规则
    expect(suggestGrant({ tool: "bash", args: { command: "npm install && npm install --force" } })).toEqual({
      tool: "bash",
      content: "npm install:*",
    });
  });

  it("复合命令不统一 → 整串精确", () => {
    expect(suggestGrant({ tool: "bash", args: { command: "git status && npm test" } })).toEqual({
      tool: "bash",
      content: "git status && npm test",
    });
    // 危险段混入：不因 git 前缀放行 rm
    expect(suggestGrant({ tool: "bash", args: { command: "git add . && rm -rf build" } })).toEqual({
      tool: "bash",
      content: "git add . && rm -rf build",
    });
  });

  it("危险根命令与解释器：只给整串精确（前缀放行=授权一族任意参数）", () => {
    expect(suggestGrant({ tool: "bash", args: { command: "rm -rf build" } })).toEqual({
      tool: "bash",
      content: "rm -rf build",
    });
    expect(suggestGrant({ tool: "bash", args: { command: "sudo npm install" } })).toEqual({
      tool: "bash",
      content: "sudo npm install",
    });
    expect(suggestGrant({ tool: "bash", args: { command: "node script.js" } })).toEqual({
      tool: "bash",
      content: "node script.js",
    });
  });

  it("可疑语法（变量/替换/重定向/续行）：整串精确", () => {
    expect(suggestGrant({ tool: "bash", args: { command: "echo $HOME" } })).toEqual({
      tool: "bash",
      content: "echo $HOME",
    });
    expect(suggestGrant({ tool: "bash", args: { command: "npm test > out.log" } })).toEqual({
      tool: "bash",
      content: "npm test > out.log",
    });
  });

  it("write/edit：目录前缀通配；根层文件整串精确", () => {
    expect(suggestGrant({ tool: "write", args: { path: "src/legacy/old.ts" } })).toEqual({
      tool: "write",
      content: "src/legacy/*",
    });
    expect(suggestGrant({ tool: "edit", args: { path: "README.md" } })).toEqual({
      tool: "edit",
      content: "README.md",
    });
    // Windows 反斜杠与 ./ 前缀归一（与匹配主体同源）
    expect(suggestGrant({ tool: "edit", args: { path: ".\\src\\app.ts" } })).toEqual({
      tool: "edit",
      content: "src/*",
    });
  });

  it("其他工具不提供参数级建议（null → 回落整工具名）", () => {
    expect(suggestGrant({ tool: "web_fetch", args: { url: "https://x" } })).toBeNull();
    expect(suggestGrant({ tool: "bash", args: {} })).toBeNull();
  });
});

describe("format/parse 往返 + grantSubject 归一", () => {
  it("往返一致", () => {
    expect(parseGrantPattern(formatGrantPattern({ tool: "bash", content: "npm:*" }))).toEqual({
      tool: "bash",
      content: "npm:*",
    });
    expect(parseGrantPattern("write")).toEqual({ tool: "write" });
  });

  it("grantSubject：bash 取 command（trim），write 取归一路径", () => {
    expect(grantSubject({ command: "  npm test " })).toBe("npm test");
    expect(grantSubject({ path: ".\\src\\a.ts" })).toBe("src/a.ts");
    expect(grantSubject({ path: "./b.ts" })).toBe("b.ts");
    expect(grantSubject("not-an-object")).toBeUndefined();
  });
});
