import { discoverCommands, discoverSkills, buildExtensionRoots, type InstalledPlugin } from "@kcode/extensions";

/**
 * kcode skills/commands list（N3C-3）：headless 盘点扩展面。
 * 与会话组装共用 buildExtensionRoots（单一事实源）——CLI 盘到的就是会话装到的。
 */

const SOURCE_LABELS = { project: "项目", user: "用户", builtin: "内置", plugin: "插件" } as const;

/** 插件条目的归属标签：命令根以 project 身份装载，需按 installPath 前缀还原插件名 */
function sourceLabel(filePath: string, source: string, plugins: InstalledPlugin[]): string {
  const hit = plugins.find((p) => filePath.startsWith(p.installPath));
  return hit !== undefined ? `插件 ${hit.manifest.name}` : (SOURCE_LABELS as Record<string, string>)[source] ?? source;
}

export async function skillsListCommand(
  cwd: string,
  kcodeHomeDir: string,
  write: (line: string) => void,
): Promise<void> {
  const roots = await buildExtensionRoots({ cwd, kcodeHomeDir });
  const skills = await discoverSkills(roots.skillRoots);
  if (skills.length === 0) {
    write("（未发现技能——放 .kcode/skills/<名>/SKILL.md 或 ~/.kcode/skills/<名>/SKILL.md）");
    return;
  }
  for (const s of skills) {
    write(`${s.manifest.name} — ${s.manifest.description}（${sourceLabel(s.filePath, s.source, roots.plugins)}）`);
  }
}

export async function commandsListCommand(
  cwd: string,
  kcodeHomeDir: string,
  write: (line: string) => void,
): Promise<void> {
  const roots = await buildExtensionRoots({ cwd, kcodeHomeDir });
  const commands = await discoverCommands(roots.commandRoots);
  if (commands.length === 0) {
    write("（未发现自定义命令——放 .kcode/commands/<名>.md 或 ~/.kcode/commands/<名>.md）");
    return;
  }
  for (const c of commands) {
    write(`/${c.name}（${sourceLabel(c.filePath, c.source, roots.plugins)}）`);
  }
}
