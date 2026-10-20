import { describe, expect, it } from "vitest";
import { mergeStdinPrompt, parseCliArgs, UsageError } from "../src/args.js";

describe("parseCliArgs（N3C-1 参数解析）", () => {
  it("子命令首 token 命中即短路，后续 token 原样透传", () => {
    const r = parseCliArgs(["key", "add", "ref", "--force"]);
    expect(r.command).toEqual({ kind: "key", args: ["add", "ref", "--force"] });
    expect(parseCliArgs(["doctor"]).command).toEqual({ kind: "doctor", args: [] });
    expect(parseCliArgs(["init"]).command).toEqual({ kind: "init", args: [] });
  });

  it("2-04 帮助与用法错误：-h/--help；未知 flag 抛 UsageError", () => {
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["--settings", "E:/tmp/kcode.json"]).settings).toBe("E:/tmp/kcode.json");
    expect(parseCliArgs(["--interactive"]).interactive).toBe(true);
    expect(parseCliArgs(["--output-format", "json"]).outputFormat).toBe("json");
    expect(parseCliArgs(["--max-turns", "3"]).maxTurns).toBe(3);
    expect(parseCliArgs(["--ephemeral"]).ephemeral).toBe(true);
    expect(parseCliArgs(["--session-id", "sess_fixed"]).sessionId).toBe("sess_fixed");
    expect(() => parseCliArgs(["--output-format", "xml"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--max-turns", "0"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--bad"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--mode", "yolo"])).toThrow(UsageError);
  });

  it("2-08 stdin 管道合并：上下文前置；`-` 整段替换；空 stdin 不污染 prompt", () => {
    expect(mergeStdinPrompt("log line\r\n", "explain")).toBe("log line\n\nexplain");
    expect(mergeStdinPrompt("hello", "-")).toBe("hello");
    expect(mergeStdinPrompt("  \n", "explain")).toBe("explain");
  });

  it("位置参数拼为提示词；-p 显式提示词等价", () => {
    expect(parseCliArgs(["帮我看下", "这个报错"]).positionalPrompt).toBe("帮我看下 这个报错");
    expect(parseCliArgs(["-p", "单次提问"]).prompt).toBe("单次提问");
    expect(parseCliArgs(["--prompt", "x"]).prompt).toBe("x");
  });

  it("-p 与位置参数提示词互斥", () => {
    expect(() => parseCliArgs(["-p", "a", "b"])).toThrow("只能提供一处");
  });

  it("--mode 枚举校验：合法四档通过，非法值报错并列出可选项", () => {
    expect(parseCliArgs(["--mode", "plan"]).mode).toBe("plan");
    expect(parseCliArgs(["--mode", "fullAccess"]).mode).toBe("fullAccess");
    expect(() => parseCliArgs(["--mode", "yolo"])).toThrow("plan | default | acceptEdits | fullAccess");
  });

  it("-c 与 --continue 等价于 --resume latest；--resume 存原值", () => {
    expect(parseCliArgs(["-c"]).resume).toBe("latest");
    expect(parseCliArgs(["--continue"]).resume).toBe("latest");
    expect(parseCliArgs(["-r", "sess_abc"]).resume).toBe("sess_abc");
  });

  it("-i/--image/--attach 同入附件管线", () => {
    const r = parseCliArgs(["-i", "a.png", "--image", "b.png", "--attach", "c.png"]);
    expect(r.images).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("--disallowed-tools 逗号/空格分隔、多次出现累积", () => {
    const r = parseCliArgs(["--disallowed-tools", "write, edit", "--disallowed-tools", "task"]);
    expect(r.disallowedTools).toEqual(["write", "edit", "task"]);
  });

  it("-- 与 --json", () => {
    const r = parseCliArgs(["--json"]);
    expect(r.json).toBe(true);
    // `--` 之后即使 - 开头也是提示词文本
    const r2 = parseCliArgs(["--", "-不是flag", "正文"]);
    expect(r2.positionalPrompt).toBe("-不是flag 正文");
  });

  it("未知 flag 报错（不再静默拼进提问）并列出用法", () => {
    expect(() => parseCliArgs(["--no-such"])).toThrow(/未知参数：--no-such[\s\S]*用法/);
  });

  it("缺值的 flag 报错", () => {
    expect(() => parseCliArgs(["--mode"])).toThrow("需要一个值");
    expect(() => parseCliArgs(["-p"])).toThrow("需要一个值");
  });
});

describe("N3F-5 --model 旗标", () => {
  it("--model 取值进 model 字段，可与其他旗标组合", () => {
    const r = parseCliArgs(["--model", "deepseek/deepseek-chat", "--json", "-p", "hi"]);
    expect(r.model).toBe("deepseek/deepseek-chat");
    expect(r.json).toBe(true);
    expect(r.prompt).toBe("hi");
  });

  it("缺值报错；非法形态（空）报错", () => {
    expect(() => parseCliArgs(["--model"])).toThrow("需要一个值");
  });
});
