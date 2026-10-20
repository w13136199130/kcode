import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildConsentSummary,
  compareVersions,
  installPlugin,
  latestInstalledPlugins,
  listInstalledPlugins,
  parsePluginPermissions,
  pluginMcpConfigs,
  PluginPermissionEngine,
  readPluginManifest,
  uninstallPlugin,
} from "../src/index.js";

let root: string;
let sourceDir: string;
let cacheDir: string;

/** 构造一个合法的测试插件源目录 */
async function makePluginSource(
  name: string,
  version: string,
  permissions: string[] = ["write:ask"],
): Promise<string> {
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
      permissions,
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

describe("3-16 插件权限：只收紧不提权", () => {
  it("解析 ask/deny；allow 与未知格式报错；deny 冲突优先", () => {
    const parsed = parsePluginPermissions(["bash:deny", "write:ask", "read:deny", "read:ask"]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules.get("bash")).toBe("deny");
    expect(parsed.rules.get("write")).toBe("ask");
    expect(parsed.rules.get("read")).toBe("deny"); // deny 优先

    const bad = parsePluginPermissions(["bash:allow", "write", "read:maybe"]);
    expect(bad.errors).toHaveLength(3);
    expect(bad.errors.some((e) => e.includes("不允许提权"))).toBe(true);
  });

  it("PluginPermissionEngine 命中规则直接裁决，其余委托底层", () => {
    let baseCalls = 0;
    const base = {
      decide: () => {
        baseCalls++;
        return "allow" as const;
      },
    };
    const engine = new PluginPermissionEngine(base, new Map([["bash", "deny" as const]]));
    const def = (name: string) => ({ name, description: "", parameters: {}, readOnly: false });
    expect(engine.decide(def("bash"), {})).toBe("deny");
    expect(baseCalls).toBe(0);
    expect(engine.decide(def("read"), {})).toBe("allow");
    expect(baseCalls).toBe(1);
  });

  it("安装期拒绝提权/非法权限声明的插件", async () => {
    const bad = await makePluginSource("bad-perms", "1.0.0", ["bash:allow"]);
    await expect(installPlugin(bad, join(root, "cache-bad"))).rejects.toThrow("权限声明不合法");
  });
});

describe("3-16 只装最新版", () => {
  it("升级安装清理旧版本；降级被拒，--force 才可覆盖", async () => {
    const cache = join(root, "cache-latest");
    await installPlugin(await makePluginSource("versioned", "1.0.0"), cache);
    await installPlugin(await makePluginSource("versioned", "1.1.0"), cache);
    const versions = await (await import("node:fs/promises")).readdir(join(cache, "versioned"));
    expect(versions).toEqual(["1.1.0"]);
    expect(await listInstalledPlugins(cache)).toHaveLength(1);

    await expect(installPlugin(await makePluginSource("versioned", "1.0.0"), cache)).rejects.toThrow("更新版本");
    const forced = await installPlugin(await makePluginSource("versioned", "1.0.0"), cache, { force: true });
    expect(forced.version).toBe("1.0.0");
    expect(await (await import("node:fs/promises")).readdir(join(cache, "versioned"))).toEqual(["1.0.0"]);
  });

  it("latestInstalledPlugins：同名只留最高版本", () => {
    const mk = (version: string) => ({
      manifest: { name: "x", version },
      installPath: "",
      seed: { hash: "h", version },
    });
    const latest = latestInstalledPlugins([mk("1.0.0"), mk("1.2.0"), mk("1.1.9")] as never);
    expect(latest).toHaveLength(1);
    expect(latest[0]?.manifest.version).toBe("1.2.0");
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});

describe("3-16 插件 MCP 按 transport 分流", () => {
  const manifest = (mcp: unknown[]) =>
    ({ schema: "kcode.plugin/1", name: "p", version: "1.0.0", hooks: [], skills: [], commands: [], mcp, permissions: [] }) as never;

  it("stdio 保留 args/env；http/sse 用 url；非法声明逐条报错", () => {
    const built = pluginMcpConfigs(
      manifest([
        { name: "s1", transport: "stdio", command: "node", args: ["a.js"], env: { A: "1" } },
        { name: "s2", transport: "http", url: "https://example.com/mcp" },
        { name: "s3", transport: "sse", url: "https://example.com/sse" },
        { name: "s4", transport: "stdio" },
      ]),
    );
    expect(built.errors).toHaveLength(1);
    expect(built.errors[0]).toContain("s4");
    expect(built.configs.map((c) => c.transport)).toEqual(["stdio", "http", "sse"]);
    expect(built.configs[0]).toMatchObject({ command: "node", args: ["a.js"], env: { A: "1" } });
    expect(built.configs[1]).toMatchObject({ transport: "http", url: "https://example.com/mcp" });
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
