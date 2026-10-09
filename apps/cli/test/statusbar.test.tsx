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
  it("CC 样张形态：⏵ 模式段+切换提示+短模型名+上下文措辞+圆点分隔（ctx 缩写已废）", () => {
    const { lastFrame } = render(
      <StatusBar
        mode="default"
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
    expect(frame).toContain("⏵ 变更确认");
    expect(frame).toContain("（shift+tab 切换）");
    expect(frame).toContain("chat"); // 模型短名（provider 前缀省略）
    expect(frame).toContain("上下文 31%");
    expect(frame).not.toContain("ctx"); // 缩写换中文直觉措辞
    expect(frame).not.toContain("24k/77k"); // 绝对值归 /context
    expect(frame).not.toContain("⇅"); // 累计用量归 /cost
    expect(frame).toContain("⎇ main");
  });

  it("无用量/分支时两段整体隐藏（不残留分隔符）；busy 态不再显示切换提示", () => {
    const idle = render(
      <StatusBar mode="plan" modelLabel="m" verbose={false} repaintTick={0} busy={false} />,
    );
    const frame = idle.lastFrame() ?? "";
    expect(frame).toContain("⏸ 只读");
    expect(frame).not.toContain("上下文");
    expect(frame).not.toContain("⎇");
    const busy = render(
      <StatusBar mode="default" modelLabel="m" verbose={false} repaintTick={0} busy={true} />,
    );
    const bframe = busy.lastFrame() ?? "";
    expect(bframe).not.toContain("shift+tab"); // 忙时提示让位
    expect(bframe).toContain("Ctrl+C 取消");
  });

  it("余量占用超 85% 时正常渲染警示分支（测试环境剥离 ANSI，色码不可断言）", () => {
    const { lastFrame } = render(
      <StatusBar
        mode="default"
        modelLabel="m"
        verbose={false}
        repaintTick={0}
        busy={false}
        usage={{ inputTokens: 1, outputTokens: 1, calls: 1, historyTokens: 9000, historyBudget: 10000 }}
        branch={null}
      />,
    );
    expect(lastFrame()).toContain("上下文 90%");
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
