import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessHookRunner, loadHookConfigs, trustProject } from "../src/index.js";

let root: string;
let hookScript: string;

/** 测试钩子脚本：按 argv[2] 决定行为（allow/block/mutate/timeout） */
const HOOK_SCRIPT = `import { readFileSync } from "node:fs";
const mode = process.argv[2] ?? "allow";
const input = readFileSync(0, "utf8");
if (mode === "block") { console.log(\`被钩子拦截（收到 \${input.length} 字节载荷）\`); process.exit(2); }
if (mode === "mutate") { console.log(JSON.stringify({ action: "mutate", args: { msg: "改写后的参数" } })); process.exit(0); }
if (mode === "timeout") { await new Promise(() => {}); }
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
    expect(warnsTimeout.some((w) => w.includes("超时") || w.includes("异常"))).toBe(true);

    const warnsFail: string[] = [];
    const outcomeFail = await makeRunner("fail", warnsFail).preToolUse(call);
    expect(outcomeFail.veto).toBe(false);
    expect(warnsFail.length).toBeGreaterThan(0);
  });

  it("postToolUse 与生命周期钩子正常执行不抛错", async () => {
    const runner = new ProcessHookRunner(
      [
        { event: "post_tool_use", command: cmd("allow") },
        { event: "session_start", command: cmd("allow") },
        { event: "stop", command: cmd("allow") },
      ],
      { sessionId: "s" },
    );
    await expect(runner.postToolUse(call, { ok: true, output: "done" })).resolves.toBeUndefined();
    await expect(runner.onSessionStart?.({ sessionId: "s" })).resolves.toBeUndefined();
    await expect(runner.onStop?.({ sessionId: "s" })).resolves.toBeUndefined();
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
