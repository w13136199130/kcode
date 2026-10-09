import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "../src/tui/input/builtin-commands.js";

/**
 * 内置命令分发链护栏（N3I 后续加固）：
 * 每个菜单里宣传的内置命令，分发源码里必须有 `name === "<名>"` 的处理器——
 * /mode 曾被拆分重构误写成 "ctx.mode"、/exit 曾只认不带斜杠的裸 exit，
 * 两个都是潜伏数周的"菜单宣传了但打出来是未知命令"，此类 bug 用源码对账一次锁死。
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, "../src/tui/input/commands.ts"), "utf8");

describe("内置命令分发链对账", () => {
  it("每个内置命令在分发链有 `name === \"<名>\"` 处理器", () => {
    const missing: string[] = [];
    for (const cmd of BUILTIN_COMMANDS) {
      const pattern = `name === "${cmd.name}"`;
      if (!source.includes(pattern)) {
        missing.push(cmd.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("分发链无 ctx. 前缀的脏键（拆分迁移时的手滑形态）", () => {
    expect(source).not.toMatch(/name === "ctx\./);
  });
});
