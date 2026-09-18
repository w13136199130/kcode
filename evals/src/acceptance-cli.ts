import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserConfigFile } from "@kcode/contracts";
import { ScriptedLLM } from "@kcode/core";
import { EncryptedFileKeychain, createProviderRouter } from "@kcode/platform";
import type { LLMProvider } from "@kcode/contracts";
import { runAcceptance, type AcceptanceTask } from "./acceptance.js";

/**
 * P1 验收入口（§9：真实仓库完成 10 个任务，Win+Mac 各跑一轮）：
 *   pnpm --filter @kcode/evals acceptance --scripted          # 框架自检（无网络）
 *   KCODE_ACCEPTANCE_MODEL=deepseek/deepseek-chat \
 *   KCODE_KEYCHAIN_PASSPHRASE=... pnpm --filter @kcode/evals acceptance   # 真实模型
 */
async function main(): Promise<void> {
  const scripted = process.argv.includes("--scripted");
  let llmFor: (task: AcceptanceTask) => LLMProvider;
  let model: string;

  if (scripted) {
    llmFor = (task) => new ScriptedLLM(task.script());
    model = "scripted";
  } else {
    const configPath = join(homedir(), ".kcode", "config.json");
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch {
      throw new Error(`真实模型模式需要 ${configPath}（或先用 --scripted 自检）`);
    }
    const parsed = UserConfigFile.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.models === undefined) {
      throw new Error(`配置不合法: ${parsed.success ? "缺少 models" : parsed.error.message}`);
    }
    const models = parsed.data.models;
    const keychain = EncryptedFileKeychain.fromEnv(join(homedir(), ".kcode", "keys.json"));
    const router = createProviderRouter(models, keychain);
    model = process.env["KCODE_ACCEPTANCE_MODEL"] ?? models.default ?? "";
    if (model === "") {
      throw new Error('未指定模型：设置 KCODE_ACCEPTANCE_MODEL 或 config 的 models.default');
    }
    const llm = await router.resolve(model);
    llmFor = () => llm;
  }

  const started = Date.now();
  const report = await runAcceptance(llmFor, model, (line) => console.log(line));
  console.log("\n===== P1 验收报告 =====");
  for (const r of report.results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id} ${r.name} — ${r.details}`);
  }
  console.log(
    `合计：${report.passed}/${report.total} 通过 · 模型 ${model} · ${Math.round((Date.now() - started) / 1000)}s`,
  );
  if (report.passed !== report.total) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
