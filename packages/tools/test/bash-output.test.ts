import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBashTool } from "../src/index.js";

/**
 * N3E-1/2：前台输出三段预算（内联 30k / 全文落盘 / 尾部保留）与持久目录项目边界。
 * 长输出用 node -e 生成（跨 shell 可移植）；小限额经 outputLimits 注入覆盖默认值。
 */

let root: string;
let artifacts: string;
let outside: string;
let ctx: { sessionId: string; cwd: string; callId: string };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-out-"));
  artifacts = join(root, "art");
  outside = await mkdtemp(join(tmpdir(), "kcode-outside-"));
  ctx = { sessionId: "s", cwd: root, callId: "call_1" };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const LONG = `node -e "process.stdout.write('kcode-long-line-0000;'.repeat(2000))"`; // 40k 字符

describe("N3E-1 前台输出三段预算", () => {
  it("短输出原样返回（不触发编排）", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: artifacts });
    const r = await bash.execute({ command: "echo short-ok" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("short-ok");
    expect(r.output).not.toContain("完整日志");
  });

  it("超内联预算：头尾保留 + 全文落盘 artifact + 注记路径", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: artifacts });
    const r = await bash.execute({ command: LONG }, { ...ctx, callId: "call_long" });
    expect(r.ok).toBe(true);
    // 注记与尾部：构建类输出"结尾才是结论"——末行内容必须在
    expect(r.output).toContain("完整日志已保存");
    expect(r.output).toContain("kcode-long-line-0000;");
    expect(r.output.length).toBeLessThan(35_000); // 头 30k 内（28k+2k+注）
    // artifact 是完整 40k 输出（不是只有溢出段——对标 zcode 回放写入语义）
    const artifact = join(artifacts, "call_long.log");
    const full = await readFile(artifact, "utf8");
    expect(full.length).toBeGreaterThanOrEqual(40_000);
    expect(full.endsWith("kcode-long-line-0000;")).toBe(true);
  });

  it("小限额注入（测试钩子）：头+省略注+尾组装；无 artifactsDir 降级建议重定向", async () => {
    const withArt = createBashTool({
      sessionId: "s",
      artifactsDir: artifacts,
      outputLimits: { maxInlineChars: 60, tailChars: 12, hardCapChars: 10_000 },
    });
    const r = await withArt.execute({ command: "node -e \"process.stdout.write('0123456789'.repeat(10))\"" }, { ...ctx, callId: "call_tiny" });
    expect(r.output).toContain("中间省略");
    expect(r.output).toContain("0123456789"); // 头部段
    expect(await readFile(join(artifacts, "call_tiny.log"), "utf8")).toContain("0123456789".repeat(10));

    const noArt = createBashTool({
      sessionId: "s",
      outputLimits: { maxInlineChars: 60, tailChars: 12, hardCapChars: 10_000 },
    });
    const r2 = await noArt.execute({ command: "node -e \"process.stdout.write('0123456789'.repeat(10))\"" }, ctx);
    expect(r2.output).toContain("重定向"); // 降级路径：建议 > 文件
  }, 20_000);

  it("内存硬顶：超保有上限保头尾、总量继续计数（诚实注记）", async () => {
    const bash = createBashTool({
      sessionId: "s",
      artifactsDir: artifacts,
      outputLimits: { maxInlineChars: 50, tailChars: 10, hardCapChars: 100 },
    });
    // 300 字符正文 > hardCap 100：保有头 50 + 尾 50，中间丢弃（总量含 shell 打点行，>300 如实计数）
    const r = await bash.execute({ command: "node -e \"process.stdout.write('abcdefghij'.repeat(30))\"" }, { ...ctx, callId: "call_cap" });
    expect(r.output).toMatch(/共 \d+ 字符/);
    expect(r.output).not.toContain("abcdefghij".repeat(5)); // 中段确实被丢弃
    const artifact = await readFile(join(artifacts, "call_cap.log"), "utf8");
    expect(artifact).toContain("内存保有上限");
  }, 20_000);
});

describe("N3E-2 持久目录项目边界", () => {
  it("cd 出项目：越界提示 + 下次命令回到会话目录", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: artifacts });
    // 第一次：cd 到项目外（mkdtemp 的 outside 目录，与 root 不同子树）
    const r1 = await bash.execute({ command: `cd "${outside.replace(/\\/g, "/")}" && pwd` }, ctx);
    expect(r1.output).toContain("已离开项目");
    expect(r1.output).toContain("重置回");

    // 第二次：无显式 cwd —— 应回到会话目录（root），而非滞留 outside
    const r2 = await bash.execute({ command: "pwd" }, ctx);
    const win = r2.output.toLowerCase().replace(/\\/g, "/");
    expect(win).toContain(root.toLowerCase().replace(/\\/g, "/").split("/").pop()!);
    expect(win).not.toContain(outside.toLowerCase().split("\\").pop()!.replace(/\\/g, "/"));
  }, 20_000);

  it("项目内 cd 仍持久（行为不回退）", async () => {
    const bash = createBashTool({ sessionId: "s", artifactsDir: artifacts });
    await bash.execute({ command: "mkdir -p subproj && cd subproj" }, ctx);
    const r = await bash.execute({ command: "pwd" }, ctx);
    expect(r.output.toLowerCase().replace(/\\/g, "/")).toContain("subproj");
  }, 20_000);
});
