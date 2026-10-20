import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "../src/tui/input/builtin-commands.js";
import { formatHelp, KEYBIND_HELP } from "../src/tui/input/help.js";

describe("2-24 /help 生成化", () => {
  it("所有内置命令都来自 BUILTIN_COMMANDS，隐藏别名有标注", () => {
    const text = formatHelp();
    for (const command of BUILTIN_COMMANDS) {
      expect(text).toContain(`/${command.name}`);
      if (command.hidden === true) {
        expect(text).toContain(`/${command.name}（隐藏别名）`);
      }
    }
    // 旧手写清单里的错误命令名不再出现
    expect(text).not.toContain("/ctx.mode");
  });

  it("自定义命令、按键与输入说明都渲染", () => {
    const text = formatHelp([{ name: "deploy", desc: "项目自定义命令" }]);
    expect(text).toContain("/deploy — 项目自定义命令");
    for (const line of KEYBIND_HELP) {
      expect(text).toContain(line);
    }
    expect(text).toContain("!命令 直接执行 shell");
  });

  it("命令名唯一，避免菜单/分发二义", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
