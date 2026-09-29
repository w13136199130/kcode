import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/tui/status/StatusLine.js";
import { readGitBranch } from "../src/tui/state/status-data.js";

/**
 * 状态栏常驻信息（N3C-4①）：用量/余量/分支段的存在性、隐藏性与格式；
 * readGitBranch 在真实 git 仓库（本仓库）与非仓库目录下的行为。
 */

describe("StatusBar 常驻信息段", () => {
  it("有用量与分支时渲染 ctx 百分比、token 双向与分支段", () => {
    const { lastFrame } = render(
      <StatusBar
        modeLabel="default"
        modelLabel="deepseek/chat"
        verbose={false}
        repaintTick={0}
        busy={false}
        usage={{
          inputTokens: 1234,
          outputTokens: 5678,
          calls: 3,
          historyTokens: 24000,
          historyBudget: 76800,
        }}
        branch="main"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("default");
    expect(frame).toContain("deepseek/chat");
    expect(frame).toContain("ctx 31%");
    expect(frame).toContain("24k/77k");
    expect(frame).toContain("⇅1.2k/5.7k");
    expect(frame).toContain("⎇ main");
  });

  it("无用量/分支时两段整体隐藏（不残留分隔符）", () => {
    const { lastFrame } = render(
      <StatusBar modeLabel="plan" modelLabel="m" verbose={false} repaintTick={0} busy={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("ctx");
    expect(frame).not.toContain("⎇");
    expect(frame).toContain("/mode · /help · exit");
  });

  it("余量占用超 85% 时正常渲染警示分支（测试环境剥离 ANSI，色码不可断言）", () => {
    const { lastFrame } = render(
      <StatusBar
        modeLabel="default"
        modelLabel="m"
        verbose={false}
        repaintTick={0}
        busy={false}
        usage={{ inputTokens: 1, outputTokens: 1, calls: 1, historyTokens: 9000, historyBudget: 10000 }}
        branch={null}
      />,
    );
    expect(lastFrame()).toContain("ctx 90%");
  });
});

describe("readGitBranch", () => {
  let nonRepo: string;

  beforeAll(async () => {
    nonRepo = await mkdtemp(join(tmpdir(), "kcode-git-branch-"));
  });
  afterAll(async () => {
    await rm(nonRepo, { recursive: true, force: true });
  });

  it("git 仓库内返回当前分支名", async () => {
    // 本仓库即真实 git 仓库（CI 与本地一致）
    const branch = await readGitBranch(process.cwd());
    expect(branch).not.toBeNull();
    expect(branch).toMatch(/^[^\s]+$/);
  }, 10_000);

  it("非仓库目录返回 null（状态栏隐藏分支段，不报错）", async () => {
    expect(await readGitBranch(nonRepo)).toBeNull();
  }, 10_000);
});
