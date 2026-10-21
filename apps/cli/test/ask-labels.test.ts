import { describe, expect, it } from "vitest";
import { askScopeLabels } from "../src/tui/dialogs/ask-labels.js";

/**
 * 4-02 后续：复合/多行命令的审批菜单曾把整段命令重复进两个选项，
 * 多行命令直接撑爆菜单。规则单行截断展示，选项只讲范围。
 */
describe("审批菜单授权范围文案", () => {
  it("精确命令：说“此命令”，规则压成单行并截断", () => {
    const command = 'echo "USERPROFILE=$USERPROFILE"\nfor p in "$USERPROFILE/Desktop"; do\n  ls -d "$p"\ndone';
    const labels = askScopeLabels({ tool: "bash", content: command });
    expect(labels.session).toBe("允许此命令，本会话不再询问");
    expect(labels.project).toBe("允许此命令，本项目不再询问");
    expect(labels.rule).not.toContain("\n");
    expect(labels.rule).toContain("bash:echo");
    expect(labels.rule!.length).toBeLessThanOrEqual(72);
  });

  it("前缀/通配规则：说“此类”", () => {
    expect(askScopeLabels({ tool: "bash", content: "npm install:*" }).session).toContain("允许此类");
    expect(askScopeLabels({ tool: "write", content: "src/*" }).project).toContain("允许此类");
  });

  it("无参数级建议时回退整工具文案", () => {
    const labels = askScopeLabels(null);
    expect(labels.session).toBe("允许，本会话不再询问");
    expect(labels.project).toBe("允许，本项目不再询问（持久）");
    expect(labels.rule).toBeNull();
  });
});
