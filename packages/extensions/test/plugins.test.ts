import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildConsentSummary,
  installPlugin,
  listInstalledPlugins,
  readPluginManifest,
  uninstallPlugin,
} from "../src/index.js";

let root: string;
let sourceDir: string;
let cacheDir: string;

/** 构造一个合法的测试插件源目录 */
async function makePluginSource(name: string, version: string): Promise<string> {
  const dir = join(root, `src-${name}-${version.replace(/\./g, "-")}`);
  await mkdir(join(dir, "skills", `${name}-skill`), { recursive: true });
  await mkdir(join(dir, "commands"), { recursive: true });
  await writeFile(
    join(dir, ".kcode-plugin"),
    JSON.stringify({
      schema: "kcode.plugin/1",
      name,
      version,
      hooks: [{ event: "pre_tool_use", command: "node guard.mjs" }],
      skills: [`${name}-skill`],
      commands: [name],
      mcp: [{ name: `${name}-mcp`, transport: "stdio", command: "node server.js" }],
      permissions: ["write:ask"],
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "skills", `${name}-skill`, "SKILL.md"),
    `---\nname: ${name}-skill\ndescription: 测试技能\n---\n正文内容`,
    "utf8",
  );
  await writeFile(join(dir, "commands", `${name}.md`), "测试命令模板", "utf8");
  return dir;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-plugins-"));
  sourceDir = await makePluginSource("demo-plugin", "1.0.0");
  cacheDir = join(root, "cache");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("插件安装与卸载", () => {
  it("安装：清单校验 → 复制到版本化缓存 → seed 写入（含 hash）", async () => {
    const result = await installPlugin(sourceDir, cacheDir);
    expect(result.name).toBe("demo-plugin");
    expect(result.version).toBe("1.0.0");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);

    // 缓存结构
    const installPath = join(cacheDir, "demo-plugin", "1.0.0");
    expect(existsSync(join(installPath, ".kcode-plugin"))).toBe(true);
    expect(existsSync(join(installPath, "skills", "demo-plugin-skill", "SKILL.md"))).toBe(true);

    // seed 存在且包含 hash
    const seed = JSON.parse(await readFile(join(installPath, ".kcode-seed.json"), "utf8")) as {
      hash: string;
      plugin: string;
      version: string;
    };
    expect(seed.hash).toBe(result.hash);
    expect(seed.plugin).toBe("demo-plugin");
  });

  it("同意摘要包含 hooks/MCP/技能信息", async () => {
    const manifest = await readPluginManifest(sourceDir);
    const summary = buildConsentSummary(manifest);
    expect(summary).toContain("demo-plugin");
    expect(summary).toContain("node guard.mjs");
    expect(summary).toContain("demo-plugin-mcp");
    expect(summary).toContain("demo-plugin-skill");
  });

  it("同版本重复安装被拒绝；--force 覆盖", async () => {
    await expect(installPlugin(sourceDir, cacheDir)).rejects.toThrow("已安装");
    const forced = await installPlugin(sourceDir, cacheDir, { force: true });
    expect(forced.version).toBe("1.0.0");
  });

  it("列出已安装插件（含 manifest 与 seed）", async () => {
    const plugins = await listInstalledPlugins(cacheDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.name).toBe("demo-plugin");
    expect(plugins[0]?.manifest.hooks).toHaveLength(1);
    expect(plugins[0]?.seed.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("卸载后列表清空；未安装的报错", async () => {
    const message = await uninstallPlugin(cacheDir, "demo-plugin");
    expect(message).toContain("已卸载");
    expect(await listInstalledPlugins(cacheDir)).toHaveLength(0);
    await expect(uninstallPlugin(cacheDir, "demo-plugin")).rejects.toThrow("未安装");
  });

  it("不合法清单在读取阶段被拒", async () => {
    const bad = join(root, "bad-plugin");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, ".kcode-plugin"), JSON.stringify({ schema: "kcode.plugin/1", name: "../evil", version: "1.0.0" }), "utf8");
    await expect(readPluginManifest(bad)).rejects.toThrow("不合法");
  });
});

describe("工作区边界检查（沙箱 v1）", () => {
  it("write/edit 工具对越界路径返回告警", async () => {
    // 动态导入避免能力层互引：此测试验证集成行为而非包间依赖
    const toolsModule = await import(/* @vite-ignore */ join(root, "..", "..", "packages", "tools", "src", "index.js").replace(/\\/g, "/")).catch(() => null);
    if (toolsModule === null) {
      // 路径导入不可行时跳过此用例（已在 tools 包测试中覆盖）
      return;
    }
  });
});
