import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAgentsMd } from "../src/composition-helpers.js";

let cwd: string;
let home: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "kcode-agents-cwd-"));
  home = await mkdtemp(join(tmpdir(), "kcode-agents-home-"));
  await writeFile(join(cwd, "AGENTS.md"), "项目指令：不要泄露 SECRET_PROJECT", "utf8");
  await writeFile(join(home, "AGENTS.md"), "用户指令：保持简洁", "utf8");
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("P0-0 项目 AGENTS.md trust 门控", () => {
  it("未信任：只加载用户级，不注入项目正文", async () => {
    const text = await loadAgentsMd(cwd, home, { includeProject: false });
    expect(text).toContain("保持简洁");
    expect(text).not.toContain("SECRET_PROJECT");
  });

  it("已信任：项目 + 用户都加载", async () => {
    const text = await loadAgentsMd(cwd, home, { includeProject: true });
    expect(text).toContain("SECRET_PROJECT");
    expect(text).toContain("保持简洁");
  });

  it("缺省保持旧语义：默认加载项目级", async () => {
    expect(await loadAgentsMd(cwd, home)).toContain("SECRET_PROJECT");
  });
});
