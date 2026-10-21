import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tool } from "@kcode/contracts";
import { detectDiagnostics, runDiagnostics, withDiagnostics } from "../src/index.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kcode-diag-"));
  await mkdir(join(root, "node_modules", "typescript", "bin"), { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}", "utf8");
  await writeFile(
    join(root, "node_modules", "typescript", "bin", "tsc"),
    'process.stdout.write("src/a.ts(1,1): error TS1000: fake\\n"); process.exit(1);',
    "utf8",
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("diagnostics（4-03）", () => {
  it("检测本地 tsc，不依赖 npx/网络", () => {
    const commands = detectDiagnostics(root);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ tool: "tsc", cwd: root });
  });

  it("运行诊断并保留 exit/output", async () => {
    const result = await runDiagnostics({ cwd: root, timeoutMs: 10_000 });
    expect(result.ran).toBe(true);
    expect(result.output).toContain("[tsc exit=1]");
    expect(result.output).toContain("TS1000");
  });

  it("mutation 工具成功后追加 <diagnostics>，失败不追加", async () => {
    const called: string[] = [];
    const tool: Tool = {
      definition: { name: "write", description: "", parameters: { type: "object" }, readOnly: false },
      execute: async () => {
        called.push("write");
        return { ok: true, output: "written" };
      },
    };
    const wrapped = withDiagnostics(tool);
    const result = await wrapped.execute({ path: join(root, "a.ts") }, { sessionId: "s" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("written");
    expect(result.output).toContain("<diagnostics>");
    expect(called).toEqual(["write"]);
  });
});
