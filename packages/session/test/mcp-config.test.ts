import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMcpConfigs } from "../src/index.js";

/** 3-14：项目级 `.kcode/mcp.json` 与用户级合并/信任门控 */
let home: string;
let project: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "kcode-mcp-cfg-"));
  project = await mkdtemp(join(tmpdir(), "kcode-mcp-cfg-ws-"));
  await writeFile(
    join(home, "mcp.json"),
    JSON.stringify({
      servers: [
        { name: "user-only", transport: "stdio", command: "node" },
        { name: "shared", transport: "http", url: "https://user.example.com/mcp" },
      ],
    }),
    "utf8",
  );
  await mkdir(join(project, ".kcode"), { recursive: true });
  await writeFile(
    join(project, ".kcode", "mcp.json"),
    JSON.stringify({
      servers: [
        { name: "shared", transport: "http", url: "https://project.example.com/mcp", headers: { Authorization: "Bearer t" } },
        { name: "proj-only", transport: "stdio", command: "node", env: { A: "1" } },
      ],
    }),
    "utf8",
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe("loadMcpConfigs（3-14 项目级 + trust）", () => {
  it("未信任：只装载用户级，项目配置告警忽略", async () => {
    const warns: string[] = [];
    const configs = await loadMcpConfigs(home, {
      projectDir: project,
      trusted: false,
      onWarn: (m) => warns.push(m),
    });
    expect(configs.map((c) => c.name).sort()).toEqual(["shared", "user-only"]);
    expect(configs.find((c) => c.name === "shared")?.url).toBe("https://user.example.com/mcp");
    expect(warns.some((w) => w.includes("未受信任"))).toBe(true);
  });

  it("已信任：项目级同名覆盖用户级，headers/env 保留", async () => {
    const configs = await loadMcpConfigs(home, { projectDir: project, trusted: true });
    expect(configs.map((c) => c.name).sort()).toEqual(["proj-only", "shared", "user-only"]);
    expect(configs.find((c) => c.name === "shared")).toMatchObject({
      url: "https://project.example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(configs.find((c) => c.name === "proj-only")?.env).toEqual({ A: "1" });
  });

  it("非法 JSON 告警且不阻断用户级", async () => {
    const warns: string[] = [];
    const bad = await mkdtemp(join(tmpdir(), "kcode-mcp-bad-"));
    await mkdir(join(bad, ".kcode"), { recursive: true });
    await writeFile(join(bad, ".kcode", "mcp.json"), "{oops", "utf8");
    const configs = await loadMcpConfigs(home, { projectDir: bad, trusted: true, onWarn: (m) => warns.push(m) });
    expect(configs.length).toBe(2); // 用户级两条；坏项目配置跳过
    await rm(bad, { recursive: true, force: true });
  });
});
