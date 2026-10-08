import { z } from "zod";
import type { SessionSink, Tool } from "@kcode/contracts";

/**
 * Skill 显式工具（工具面补全，对标 zcode Skill 工具）：技能正文的第三条加载通道。
 * 既有两条：触发词自动注入（match 命中注入正文）与用户 /skill 命令；本工具让模型
 * 在需要完整步骤时按名主动读取——渐进加载语义不变（metadata 常驻、正文按需）。
 * 描述里内联当前可用技能名（组装期已定），模型无需先查清单。
 */

const SkillArgs = z.object({
  name: z.string().min(1),
});

/** 描述截断（字符）：技能清单里 description 的单条上限（zcode 同思路 250，kcode 工具描述更省） */
const DESC_MAX_CHARS = 80;
/** 清单总预算（字符）：超限降级仅名字——防技能膨胀撑爆工具描述（zcode 20K 预算分级的 kcode 版） */
const LIST_BUDGET_CHARS = 2_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 技能目录对模型的可见形态（N3I-2）：`name（description 截断）` 逐行；
 * 总预算超限降级仅名字——描述让模型按意图匹配技能，不再只能按名字猜。
 */
export function formatSkillCatalog(meta: { name: string; description: string }[]): string {
  if (meta.length === 0) {
    return "（无）";
  }
  const lines = meta.map((s) => `- ${s.name}（${truncate(s.description, DESC_MAX_CHARS)}）`);
  if (lines.join("\n").length <= LIST_BUDGET_CHARS) {
    return lines.join("\n");
  }
  return truncate(meta.map((s) => s.name).join("、"), LIST_BUDGET_CHARS);
}

/** 只依赖技能库的结构形状（FsSkillLibrary 满足），避免与 extensions 具体类型耦合 */
export interface SkillToolDeps {
  skills: {
    meta(): { name: string; description: string }[];
    body(name: string): Promise<string | null>;
  };
  sink: SessionSink;
  sessionId: string;
}

export function buildSkillTool(deps: SkillToolDeps): Tool {
  const names = () => deps.skills.meta().map((s) => s.name);
  return {
    definition: {
      name: "skill",
      description: `按名加载技能正文（需要完整操作步骤时调用）。当前可用技能（名：用途）：
${formatSkillCatalog(deps.skills.meta())}`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名（来自本工具描述里的可用清单）" },
        },
        required: ["name"],
      },
      readOnly: true,
      permission: { default: "allow" },
      timeoutMs: 10_000,
      // 技能正文是操作指南，回灌历史的预算给足但封顶
      resultBudget: 4096,
    },
    async execute(input) {
      const parsed = SkillArgs.safeParse(input);
      if (!parsed.success) {
        return { ok: false, output: "", error: `参数不合法: ${parsed.error.message}` };
      }
      const name = parsed.data.name;
      const body = await deps.skills.body(name).catch(() => null);
      if (body === null || body === "") {
        return { ok: false, output: "", error: `未知技能「${name}」；可用：${names().join("、") || "（无）"}` };
      }
      // 与自动触发同源落盘：skill_used 事件让回放与 TUI 回显都能看到这次加载
      await deps.sink.append({
        v: 1,
        type: "skill_used",
        ts: Date.now(),
        sessionId: deps.sessionId,
        skill: name,
        trigger: "tool",
      });
      return { ok: true, output: body };
    },
  };
}
