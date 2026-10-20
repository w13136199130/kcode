import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessHookRunner, loadHookConfigs, normalizeHookJson, trustProject } from "../src/index.js";
import { parseHookStdout } from "../src/hooks/runner.js";

let root: string;
let hookScript: string;

/** 测试钩子脚本：按 argv[2] 决定行为（allow/block/mutate/timeout/append/CC 协议） */
const HOOK_SCRIPT = `import { appendFileSync, readFileSync } from "node:fs";
const mode = process.argv[2] ?? "allow";
const input = readFileSync(0, "utf8");
if (mode === "block") { console.log(\`被钩子拦截（收到 \${input.length} 字节载荷）\`); process.exit(2); }
if (mode === "mutate") { console.log(JSON.stringify({ action: "mutate", args: { msg: "改写后的参数" } })); process.exit(0); }
if (mode === "append") { appendFileSync(process.argv[3], "x"); process.exit(0); }
if (mode === "cc-context") { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "项目约定：先读 AGENTS.md" } })); process.exit(0); }
if (mode === "cc-deny") { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "禁止 Bash" } })); process.exit(0); }
if (mode === "cc-block") { console.log(JSON.stringify({ decision: "block", reason: "CC 决策拦截" })); process.exit(0); }
if (mode === "timeout") { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === "fail") { console.error("钩子内部错误"); process.exit(1); }
process.exit(0);
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-hooks-"));
  hookScript = join(root, "hook.mjs");
  await writeFile(hookScript, HOOK_SCRIPT, "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 以 node 直跑脚本（路径加引号，PowerShell/bash 均兼容） */
const cmd = (mode: string): string => `node "${hookScript}" ${mode}`;

function makeRunner(mode: string, warns: string[] = []): ProcessHookRunner {
  return new ProcessHookRunner(
    [{ event: "pre_tool_use", command: cmd(mode), timeoutMs: mode === "timeout" ? 800 : 10_000 }],
    { sessionId: "s", onWarn: (m) => warns.push(m) },
  );
}

describe("ProcessHookRunner（钩子裁决协议）", () => {
  const call = { callId: "c1", tool: "echo", args: { msg: "hi" } };

  it("退出码 0：放行", async () => {
    const outcome = await makeRunner("allow").preToolUse(call);
    expect(outcome).toEqual({ veto: false });
  });

  it("退出码 2：拦截并带回 stdout 原因", async () => {
    const outcome = await makeRunner("block").preToolUse(call);
    expect(outcome.veto).toBe(true);
    expect(outcome.reason).toContain("被钩子拦截");
  });

  it("stdout JSON：mutate 改写参数", async () => {
    const outcome = await makeRunner("mutate").preToolUse(call);
    expect(outcome).toEqual({ veto: false, args: { msg: "改写后的参数" } });
  });

  it("超时与非零退出码：放行并告警（钩子故障不阻断会话）", async () => {
    const warnsTimeout: string[] = [];
    const outcomeTimeout = await makeRunner("timeout", warnsTimeout).preToolUse(call);
    expect(outcomeTimeout.veto).toBe(false);
    expect(warnsTimeout.some((w) => w.includes("超时"))).toBe(true);

    const warnsFail: string[] = [];
    const outcomeFail = await makeRunner("fail", warnsFail).preToolUse(call);
    expect(outcomeFail.veto).toBe(false);
    expect(warnsFail.length).toBeGreaterThan(0);
  }, 60_000); // 包含 Windows 进程树终止与第二次 PowerShell 启动；全量并发下进程启动可能很慢（超时语义不受影响）

  it("postToolUse 与生命周期钩子正常执行不抛错", async () => {
    const warns: string[] = [];
    const runner = new ProcessHookRunner(
      [
        { event: "post_tool_use", command: cmd("allow") },
        { event: "session_start", command: cmd("allow") },
        { event: "stop", command: cmd("allow") },
      ],
      { sessionId: "s", onWarn: (message) => warns.push(message) },
    );
    await expect(runner.postToolUse(call, { ok: true, output: "done" })).resolves.toBeUndefined();
    await expect(runner.onSessionStart?.({ sessionId: "s" })).resolves.toBeUndefined();
    await expect(runner.onStop?.({ sessionId: "s" })).resolves.toBeUndefined();
    expect(warns).toEqual([]);
  }, 15_000); // 三个真实子进程顺序启动，Windows 满载时可能超过 Vitest 默认 5 秒。
});

describe("3-15 matcher 与 CC 协议", () => {
  const call = (tool: string) => ({ callId: `c-${tool}`, tool, args: {} });

  it("matcher 只对目标工具执行（工具名/正则，大小写不敏感）", async () => {
    const log = join(root, "matcher.log");
    const runner = new ProcessHookRunner(
      [{ event: "pre_tool_use", command: `node "${hookScript}" append "${log}"`, matcher: "^ba" }],
      { sessionId: "s" },
    );
    await runner.preToolUse(call("bash"));
    await runner.preToolUse(call("read")); // 不命中
    await runner.preToolUse(call("Bash")); // 大小写不敏感
    expect(await readFile(log, "utf8")).toBe("xx");
  }, 15_000);

  it("CC hookSpecificOutput.additionalContext 汇总为上下文；deny 映射为拦截", async () => {
    const contextRunner = makeRunner("cc-context");
    const outcome = await contextRunner.preToolUse(call("bash"));
    expect(outcome.veto).toBe(false);
    expect(outcome.context).toContain("项目约定");

    const denyOutcome = await makeRunner("cc-deny").preToolUse(call("bash"));
    expect(denyOutcome.veto).toBe(true);
    expect(denyOutcome.reason).toContain("禁止 Bash");

    const blockOutcome = await makeRunner("cc-block").preToolUse(call("bash"));
    expect(blockOutcome.veto).toBe(true);
    expect(blockOutcome.reason).toContain("CC 决策拦截");
  }, 20_000);

  it("post_tool_use / session_start 返回 additionalContext（不否决）", async () => {
    const warns: string[] = [];
    const runner = new ProcessHookRunner(
      [
        { event: "post_tool_use", command: cmd("cc-context") },
        { event: "session_start", command: cmd("cc-context") },
      ],
      { sessionId: "s", onWarn: (m) => warns.push(m) },
    );
    await expect(runner.postToolUse(call("bash"), { ok: true, output: "ok" })).resolves.toEqual({
      context: "项目约定：先读 AGENTS.md",
    });
    await expect(runner.onSessionStart?.({ sessionId: "s" })).resolves.toEqual({
      context: "项目约定：先读 AGENTS.md",
    });
    expect(warns).toEqual([]);
  }, 20_000);

  it("stdout 双协议解析：自有 action / CC decision / continue:false；未知 JSON 不误判", () => {
    expect(parseHookStdout(JSON.stringify({ action: "allow", additionalContext: "x" }))).toEqual({
      action: "allow",
      context: "x",
    });
    expect(parseHookStdout(JSON.stringify({ decision: "block", reason: "no" }))).toEqual({
      action: "block",
      reason: "no",
    });
    expect(parseHookStdout(JSON.stringify({ continue: false, stopReason: "stop" }))).toEqual({
      action: "block",
      reason: "stop",
    });
    expect(parseHookStdout(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } }))?.action).toBe("block");
    expect(parseHookStdout("not json")).toBeUndefined();
    expect(parseHookStdout(JSON.stringify({ hello: "world" }))).toBeUndefined();
  });
});

describe("3-15 配置形态归一化", () => {
  it("CC 形态：事件映射、matcher、timeout 秒→毫秒、未知键只告警", () => {
    const { hooks, warnings } = normalizeHookJson({
      hooks: {
        PreToolUse: [
          {
            matcher: "^Ba",
            extra: true,
            hooks: [{ type: "command", command: "echo hi", timeout: 2, mystery: 1 }],
          },
        ],
        Notification: [{ hooks: [{ type: "command", command: "x" }] }],
      },
      other: 1,
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ event: "pre_tool_use", command: "echo hi", matcher: "^Ba", timeoutMs: 2000 });
    expect(warnings.some((w) => w.includes('"extra"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"mystery"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"other"'))).toBe(true);
    expect(warnings.some((w) => w.includes("Notification"))).toBe(true);
  });

  it("自有形态：未知键告警但条目仍加载；坏条目跳过", () => {
    const { hooks, warnings } = normalizeHookJson({
      hooks: [
        { event: "stop", command: "echo ok", foo: 1 },
        { event: "not_an_event", command: "x" },
      ],
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.event).toBe("stop");
    expect(warnings.some((w) => w.includes('"foo"'))).toBe(true);
    expect(warnings.some((w) => w.includes("不合法"))).toBe(true);
  });
});

describe("loadHookConfigs（配置加载与信任门控）", () => {
  it("用户级生效；项目级未受信任时忽略，受信任后生效", async () => {
    const userDir = join(root, "home");
    const projectDir = join(root, "repo");
    const trustFile = join(root, "trusted.json");
    await mkdir(join(userDir), { recursive: true });
    await mkdir(join(projectDir, ".kcode"), { recursive: true });
    await writeFile(join(userDir, "hooks.json"), JSON.stringify({ hooks: [{ event: "stop", command: cmd("allow") }] }), "utf8");
    await writeFile(join(projectDir, ".kcode", "hooks.json"), JSON.stringify({ hooks: [{ event: "pre_tool_use", command: cmd("block") }] }), "utf8");

    const warns: string[] = [];
    let configs = await loadHookConfigs({ userDir, projectDir, trustFile, onWarn: (m) => warns.push(m) });
    expect(configs).toHaveLength(1);
    expect(warns.some((w) => w.includes("未受信任"))).toBe(true);

    await trustProject(projectDir, trustFile);
    await trustProject(projectDir, trustFile); // 幂等
    configs = await loadHookConfigs({ userDir, projectDir, trustFile });
    expect(configs).toHaveLength(2);
  });

  it("非法 JSON 与不合规结构被跳过", async () => {
    const userDir = join(root, "bad-home");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "hooks.json"), "{oops", "utf8");
    const warns: string[] = [];
    const configs = await loadHookConfigs({
      userDir,
      projectDir: join(root, "no-repo"),
      trustFile: join(root, "no-trust.json"),
      onWarn: (m) => warns.push(m),
    });
    expect(configs).toHaveLength(0);
    expect(warns.some((w) => w.includes("不是合法 JSON"))).toBe(true);
  });
});
