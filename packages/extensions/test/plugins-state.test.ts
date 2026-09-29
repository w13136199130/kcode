import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildExtensionRoots,
  filterEnabledPlugins,
  installPlugin,
  listInstalledPlugins,
  readDisabledPlugins,
  setPluginEnabled,
  verifyPluginSeed,
} from "../src/index.js";

let home: string;
let cwd: string;
let pluginsDir: string;
let cacheDir: string;

/** 最小合法插件源：清单数组字段全有默认值，技能/命令文件按需补 */
async function makePluginSource(name: string, version: string): Promise<string> {
  const dir = join(home, `src-${name}-${version.replace(/\./g, "-")}`);
  await mkdir(join(dir, "skills", `${name}-skill`), { recursive: true });
  await writeFile(join(dir, ".kcode-plugin"), JSON.stringify({ schema: "kcode.plugin/1", name, version }), "utf8");
  await writeFile(
    join(dir, "skills", `${name}-skill`, "SKILL.md"),
    `---\nname: ${name}-skill\ndescription: 测试技能\n---\n正文`,
    "utf8",
  );
  return dir;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-plugin-state-"));
  cwd = await mkdtemp(join(tmpdir(), "kcode-plugin-state-ws-"));
  pluginsDir = join(home, "cli", "plugins");
  cacheDir = join(pluginsDir, "cache");
  await installPlugin(await makePluginSource("demo", "1.0.0"), cacheDir);
  await installPlugin(await makePluginSource("demo", "2.0.0"), cacheDir);
  await installPlugin(await makePluginSource("other", "1.0.0"), cacheDir);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("插件启停状态（state.json）", () => {
  it("无状态文件时读取为空（安全降级=全启用）", async () => {
    expect(await readDisabledPlugins(pluginsDir)).toEqual([]);
  });

  it("disable 幂等追加；enable 无版本条目时连 name@* 形态一并清除", async () => {
    await setPluginEnabled(pluginsDir, "demo", false);
    await setPluginEnabled(pluginsDir, "demo", false);
    await setPluginEnabled(pluginsDir, "other@1.0.0", false);
    expect(await readDisabledPlugins(pluginsDir)).toEqual(["demo", "other@1.0.0"]);

    await setPluginEnabled(pluginsDir, "other@1.0.0", true);
    expect(await readDisabledPlugins(pluginsDir)).toEqual(["demo"]);

    await setPluginEnabled(pluginsDir, "demo", true);
    expect(await readDisabledPlugins(pluginsDir)).toEqual([]);
  });

  it("损坏的 state.json 按空处理，不阻断装配", async () => {
    await writeFile(join(pluginsDir, "state.json"), "{oops", "utf8");
    expect(await readDisabledPlugins(pluginsDir)).toEqual([]);
  });

  it("写入后无 .tmp 残留（原子替换）", async () => {
    await setPluginEnabled(pluginsDir, "demo", false);
    await setPluginEnabled(pluginsDir, "demo", true);
    expect(existsSync(join(pluginsDir, "state.json.tmp"))).toBe(false);
  });

  it("filterEnabledPlugins：name 命中全部版本，name@version 只命中精确版本", () => {
    const fake = [
      { manifest: { name: "demo", version: "1.0.0" } },
      { manifest: { name: "demo", version: "2.0.0" } },
      { manifest: { name: "other", version: "1.0.0" } },
    ];
    expect(filterEnabledPlugins(fake, ["demo"])).toHaveLength(1);
    expect(filterEnabledPlugins(fake, ["demo@1.0.0"])).toHaveLength(2);
    expect(filterEnabledPlugins(fake, [])).toHaveLength(3);
  });
});

describe("buildExtensionRoots（会话组装与 CLI 盘点共用）", () => {
  /** 用例间无隐式顺序依赖：每个用例先把启停状态清回全启用 */
  async function resetEnabled(): Promise<void> {
    for (const id of ["demo", "other", "demo@1.0.0", "other@1.0.0"]) {
      await setPluginEnabled(pluginsDir, id, true);
    }
  }

  it("默认全启用：根顺序 project > user > 插件目录（每个插件一个）", async () => {
    await resetEnabled();
    const roots = await buildExtensionRoots({ cwd, kcodeHomeDir: home });
    expect(roots.plugins).toHaveLength(3);
    expect(roots.skillRoots.map((r) => r.source)).toEqual(["project", "user", "plugin", "plugin", "plugin"]);
    // 插件命令沿用 project 身份（项目同名命令可覆盖插件命令）
    expect(roots.commandRoots.every((r) => r.source === "project" || r.source === "user")).toBe(true);
  });

  it("停用 demo（全部版本）：plugins 过滤、对应根不再出现、disabledIds 可见", async () => {
    await resetEnabled();
    await setPluginEnabled(pluginsDir, "demo", false);
    const roots = await buildExtensionRoots({ cwd, kcodeHomeDir: home });
    expect(roots.plugins.map((p) => p.manifest.name)).toEqual(["other"]);
    // project + user + other（demo 的两个版本都不再贡献根）
    expect(roots.skillRoots).toHaveLength(3);
    expect(roots.disabledIds).toEqual(["demo"]);

    await setPluginEnabled(pluginsDir, "demo", true); // 还原，避免影响其他用例
  });

  it("停用精确版本 demo@1.0.0：2.0.0 仍在", async () => {
    await resetEnabled();
    await setPluginEnabled(pluginsDir, "demo@1.0.0", false);
    const roots = await buildExtensionRoots({ cwd, kcodeHomeDir: home });
    expect(roots.plugins.map((p) => `${p.manifest.name}@${p.manifest.version}`).sort()).toEqual([
      "demo@2.0.0",
      "other@1.0.0",
    ]);

    await setPluginEnabled(pluginsDir, "demo@1.0.0", true);
  });
});

describe("加载期完整性校验（N3-5）", () => {
  it("安装后未篡改：校验通过（seed 自身排除在哈希外）", async () => {
    const plugins = await listInstalledPlugins(cacheDir);
    for (const p of plugins) {
      expect(await verifyPluginSeed(p.installPath, p.seed.hash)).toBe(true);
    }
  });

  it("内容被篡改：verifyPluginSeed 失败，buildExtensionRoots 拒绝装载并告警", async () => {
    const plugins = await listInstalledPlugins(cacheDir);
    const target = plugins.find((p) => p.manifest.name === "other")!;
    const skillFile = join(target.installPath, "skills", "other-skill", "SKILL.md");
    await writeFile(skillFile, "---\nname: other-skill\ndescription: 被篡改\n---\n恶意内容", "utf8");

    expect(await verifyPluginSeed(target.installPath, target.seed.hash)).toBe(false);

    const warnings: string[] = [];
    const roots = await buildExtensionRoots({ cwd, kcodeHomeDir: home, onWarn: (m) => warnings.push(m) });
    expect(roots.plugins.map((p) => p.manifest.name)).not.toContain("other");
    expect(warnings.some((m) => m.includes("other@1.0.0") && m.includes("完整性校验失败"))).toBe(true);

    // 重装修复：force 覆盖后校验恢复通过
    await installPlugin(await makePluginSource("other", "1.0.0"), cacheDir, { force: true });
    const after = await buildExtensionRoots({ cwd, kcodeHomeDir: home });
    expect(after.plugins.map((p) => p.manifest.name)).toContain("other");
  });
});
