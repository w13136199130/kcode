import { join } from "node:path";
import {
  latestInstalledPlugins,
  listInstalledPlugins,
  verifyInstalledPlugin,
  type InstalledPlugin,
} from "./plugins/install.js";
import { loadTrustedKeys } from "./plugins/signing.js";
import { parsePluginPermissions } from "./plugins/permissions.js";
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
  /** 项目是否已 /trust；false 时 project 根只出现在 untrusted*，不参与会话装载 */
  trusted: boolean;
  skillRoots: SkillSource[];
  commandRoots: CommandSource[];
  /** 未信任项目的根：CLI 盘点可展示“已发现但未装载” */
  untrustedSkillRoots: SkillSource[];
  untrustedCommandRoots: CommandSource[];
}

export async function buildExtensionRoots(opts: {
  cwd: string;
  kcodeHomeDir: string;
  /** 项目是否已 /trust（2-17）；缺省 true 保持既有测试/调用语义，会话组装必须显式传 */
  trusted?: boolean;
  /** 完整性校验失败等装载期告警的出口（会话组装传 onNotice，CLI 传打印） */
  onWarn?: (message: string) => void;
}): Promise<ExtensionRoots> {
  const trusted = opts.trusted ?? true;
  const projectSkill: SkillSource = { dir: join(opts.cwd, ".kcode", "skills"), source: "project" };
  const projectCommand: CommandSource = { dir: join(opts.cwd, ".kcode", "commands"), source: "project" };
  const pluginsDir = join(opts.kcodeHomeDir, "cli", "plugins");
  const disabled = await readDisabledPlugins(pluginsDir);
  // 3-16：同名插件只装载最高版本（安装期已清理旧版，这里兜底历史缓存）
  const enabled = filterEnabledPlugins(
    latestInstalledPlugins(await listInstalledPlugins(join(pluginsDir, "cache"))),
    disabled,
  );
  const plugins: InstalledPlugin[] = [];
  const trustedKeys = await loadTrustedKeys(opts.kcodeHomeDir);
  const requireSignature = process.env["KCODE_PLUGIN_REQUIRE_SIGNATURE"] === "1";
  for (const p of enabled) {
    // 3-16：权限声明不合法/请求提权的插件拒绝装载（同意摘要不能写得比实际能力弱）
    const permissionErrors = parsePluginPermissions(p.manifest.permissions).errors;
    if (permissionErrors.length > 0) {
      opts.onWarn?.(
        `插件 ${p.manifest.name}@${p.manifest.version} 权限声明不合法，已拒绝装载：${permissionErrors.join("；")}`,
      );
      continue;
    }
    // 4-08：hash 锁内容 + 签名锁发布者；未签名仅在非 strict 模式放行
    const verified = await verifyInstalledPlugin(p, { trustedKeys, requireSignature });
    if (verified.ok) {
      plugins.push(p);
    } else {
      opts.onWarn?.(
        `插件 ${p.manifest.name}@${p.manifest.version} ${
          verified.reason?.includes("内容") ? "完整性校验失败" : "签名校验失败"
        }（${verified.reason ?? "未知原因"}），已拒绝装载——kcode plugin install <目录> --force 重装可修复`,
      );
    }
  }
  return {
    plugins,
    disabledIds: disabled,
    trusted,
    skillRoots: [
      ...(trusted ? [projectSkill] : []),
      { dir: join(opts.kcodeHomeDir, "skills"), source: "user" },
      ...plugins.map((p) => ({ dir: join(p.installPath, "skills"), source: "plugin" as const })),
    ],
    // 插件命令沿用既有语义：以 project 身份装载（项目同名命令仍可覆盖它）
    commandRoots: [
      ...(trusted ? [projectCommand] : []),
      { dir: join(opts.kcodeHomeDir, "commands"), source: "user" },
      ...plugins.map((p) => ({ dir: join(p.installPath, "commands"), source: "project" as const })),
    ],
    untrustedSkillRoots: trusted ? [] : [projectSkill],
    untrustedCommandRoots: trusted ? [] : [projectCommand],
  };
}
