import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  McpServersFile,
  platformClientAdapter,
  type IPlatformService,
  type UserModelsConfig,
} from "@kcode/contracts";
import { rgPath } from "@kcode/tools";
import { kcodeHome, loadUserConfig, requireDefaultModelRef } from "./bootstrap.js";

/**
 * kcode doctor（N3C-2）：运行环境自检。每项检查独立成条——doctor 的职责是
 * 汇总现场而非中途失败，单项异常落为 ✗ 记录后继续。
 * 返回 false 表示存在需要处理的项（main 依此决定退出码）。
 */

interface CheckResult {
  ok: boolean;
  /** ok 但值得提醒（如 conhost 终端、口令未设）——不算失败 */
  warn?: boolean;
  label: string;
  detail: string;
}

/** 单项检查：run 抛错即失败，异常消息就是诊断内容 */
async function check(label: string, run: () => Promise<string>): Promise<CheckResult> {
  try {
    return { ok: true, label, detail: await run() };
  } catch (err) {
    return { ok: false, label, detail: err instanceof Error ? err.message : String(err) };
  }
}

function nodeCheck(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= 22) {
    return { ok: true, label: "Node", detail: `v${process.versions.node}（要求 ≥22）` };
  }
  return { ok: false, label: "Node", detail: `v${process.versions.node} 低于要求的 22` };
}

function keychainCheck(platform: IPlatformService, home: string): CheckResult {
  const keysFile = join(home, "keys.json");
  if (platform.secureStorageAvailable) {
    return { ok: true, label: "钥匙串", detail: "Windows DPAPI 免口令可用" };
  }
  if (existsSync(keysFile)) {
    const hasPass = (process.env["KCODE_KEYCHAIN_PASSPHRASE"] ?? "") !== "";
    return {
      ok: true,
      warn: !hasPass,
      label: "钥匙串",
      detail: hasPass ? "口令 keychain（口令已在环境变量）" : "口令 keychain 存在，但本终端未设 KCODE_KEYCHAIN_PASSPHRASE（启动时会交互询问）",
    };
  }
  return {
    ok: true,
    warn: true,
    label: "钥匙串",
    detail: "未找到 keys.json——若模型需要 API key 请先 kcode key add（纯 Ollama 等本地模型可忽略）",
  };
}

function rgCheck(): CheckResult {
  if (existsSync(rgPath)) {
    return { ok: true, label: "ripgrep", detail: `捆绑 rg 就位（${rgPath}）` };
  }
  return { ok: false, label: "ripgrep", detail: `捆绑 rg 缺失：${rgPath} 不存在（重装可修复）` };
}

/** 默认模型的 key 探测：只探测 default 指向的 provider，无 keyRef（Ollama 等）视为通过 */
async function defaultKeyCheck(
  platform: IPlatformService,
  models: UserModelsConfig,
  defaultRef: string,
): Promise<CheckResult> {
  return check("默认模型 key", async () => {
    const providerName = defaultRef.split("/")[0] ?? "";
    const provider = models.providers[providerName];
    if (provider === undefined) {
      throw new Error(`配置中不存在 provider "${providerName}"（default = ${defaultRef}）`);
    }
    // gateway 型无 keyRef（联合类型需先收窄）；openai-compatible 的 keyRef 可选
    const keyRef = "keyRef" in provider ? provider.keyRef : undefined;
    if (keyRef === undefined) {
      return `${providerName} 无需 key`;
    }
    const available = await platformClientAdapter(platform).probe(keyRef);
    if (!available) {
      throw new Error(`keychain 中没有 ${keyRef}——kcode key add 录入后重试`);
    }
    return `${keyRef} 可解密`;
  });
}

async function mcpCheck(home: string): Promise<CheckResult> {
  return check("MCP 配置", async () => {
    let raw: string;
    try {
      raw = await readFile(join(home, "mcp.json"), "utf8");
    } catch {
      return "未配置（跳过）";
    }
    const parsed = McpServersFile.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`mcp.json 不合法：${parsed.error.message}`);
    }
    return `${parsed.data.servers.length} 个服务器`;
  });
}

async function sessionsDirCheck(home: string): Promise<CheckResult> {
  return check("会话目录可写", async () => {
    const dir = join(home, "cli", "sessions");
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.doctor-probe-${Date.now()}`);
    await writeFile(probe, "x", "utf8");
    await rm(probe, { force: true });
    return dir;
  });
}

function terminalCheck(): CheckResult {
  if (process.stdout.isTTY !== true) {
    return { ok: true, warn: true, label: "终端", detail: "stdout 非直接终端（管道/重定向）——交互界面会受影响" };
  }
  if (process.platform === "win32" && process.env["WT_SESSION"] === undefined && process.env["TERM_PROGRAM"] === undefined) {
    return { ok: true, warn: true, label: "终端", detail: "检测到非 Windows Terminal / VS Code 终端，界面可能整段重复（conhost 无 VT 序列）" };
  }
  return { ok: true, label: "终端", detail: "交互能力正常" };
}

export async function doctorCommand(
  platform: IPlatformService,
  write: (line: string) => void,
  home: string = kcodeHome(),
): Promise<boolean> {
  const results: CheckResult[] = [nodeCheck()];
  // 配置先查：key 探测依赖其结果，配置失败时跳过探测（两件事不混为一条诊断）
  let models: UserModelsConfig | undefined;
  let defaultRef: string | undefined;
  results.push(
    await check("配置与默认模型", async () => {
      models = await loadUserConfig(join(home, "config.json"));
      defaultRef = requireDefaultModelRef(models);
      return `default = ${defaultRef}`;
    }),
  );
  results.push(keychainCheck(platform, home));
  if (models !== undefined && defaultRef !== undefined) {
    results.push(await defaultKeyCheck(platform, models, defaultRef));
  }
  results.push(rgCheck());
  results.push(await mcpCheck(home));
  results.push(await sessionsDirCheck(home));
  results.push(terminalCheck());

  for (const r of results) {
    const mark = r.ok ? (r.warn === true ? "⚠" : "✓") : "✗";
    write(`${mark} ${r.label} — ${r.detail}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  write(bad === 0 ? `\n全部 ${results.length} 项检查通过` : `\n${bad} 项需要处理（见上）`);
  return bad === 0;
}
