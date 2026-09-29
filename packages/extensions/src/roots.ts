import { join } from "node:path";
import { listInstalledPlugins, verifyPluginSeed, type InstalledPlugin } from "./plugins/install.js";
import { filterEnabledPlugins, readDisabledPlugins } from "./plugins/state.js";
import type { SkillSource } from "./skills/discover.js";
import type { CommandSource } from "./commands/index.js";

/**
 * 技能/命令根目录构造（N3C-3 单一事实源）：会话组装（packages/session）与
 * CLI 列举子命令（skills list / commands list）共用同一份优先级规则——
 * project > user > 插件目录。两处各自维护会悄悄漂移，故提取于此。
 * 加载期完整性校验（N3-5）也在此收口：与 seed 比对失败即拒绝装载（fail-closed），
 * 会话组装与 CLI 盘点拿到的是同一份"已验证且启用"的集合。
 */
export interface ExtensionRoots {
  /** 启用中的插件（disabled 已过滤、seed 校验通过；技能/命令根、MCP 装载、计数提示都用它） */
  plugins: InstalledPlugin[];
  /** 停用清单原始条目（plugin list 显示 [已停用] 标注用） */
  disabledIds: string[];
  skillRoots: SkillSource[];
  commandRoots: CommandSource[];
}

export async function buildExtensionRoots(opts: {
  cwd: string;
  kcodeHomeDir: string;
  /** 完整性校验失败等装载期告警的出口（会话组装传 onNotice，CLI 传打印） */
  onWarn?: (message: string) => void;
}): Promise<ExtensionRoots> {
  const pluginsDir = join(opts.kcodeHomeDir, "cli", "plugins");
  const disabled = await readDisabledPlugins(pluginsDir);
  const enabled = filterEnabledPlugins(await listInstalledPlugins(join(pluginsDir, "cache")), disabled);
  const plugins: InstalledPlugin[] = [];
  for (const p of enabled) {
    // 每次组装都重算哈希：插件体量小（技能/命令文件），换缓存反而引入失效复杂度
    if (await verifyPluginSeed(p.installPath, p.seed.hash)) {
      plugins.push(p);
    } else {
      opts.onWarn?.(
        `插件 ${p.manifest.name}@${p.manifest.version} 完整性校验失败（内容与安装时不一致），已拒绝装载——kcode plugin install <目录> --force 重装可修复`,
      );
    }
  }
  return {
    plugins,
    disabledIds: disabled,
    skillRoots: [
      { dir: join(opts.cwd, ".kcode", "skills"), source: "project" },
      { dir: join(opts.kcodeHomeDir, "skills"), source: "user" },
      ...plugins.map((p) => ({ dir: join(p.installPath, "skills"), source: "plugin" as const })),
    ],
    // 插件命令沿用既有语义：以 project 身份装载（项目同名命令仍可覆盖它）
    commandRoots: [
      { dir: join(opts.cwd, ".kcode", "commands"), source: "project" },
      { dir: join(opts.kcodeHomeDir, "commands"), source: "user" },
      ...plugins.map((p) => ({ dir: join(p.installPath, "commands"), source: "project" as const })),
    ],
  };
}
