import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HookConfigFile, type HookConfig } from "@kcode/contracts";

export interface HookLoadOptions {
  /** 用户级配置目录（~/.kcode） */
  userDir: string;
  /** 项目根目录；其 .kcode/hooks.json 仅在受信任时生效 */
  projectDir: string;
  /** 受信任项目清单文件（JSON 数组，元素为项目绝对路径） */
  trustFile: string;
  onWarn?: (message: string) => void;
}

/**
 * 加载钩子配置：用户级始终生效；项目级需要项目路径出现在受信任清单里——
 * 防止克隆来的仓库通过项目级钩子在会话启动时执行任意命令。
 */
export async function loadHookConfigs(options: HookLoadOptions): Promise<HookConfig[]> {
  const configs: HookConfig[] = [];
  configs.push(...(await loadFile(join(options.userDir, "hooks.json"), "用户级", options.onWarn)));

  const trusted = await readTrustedProjects(options.trustFile);
  if (trusted.includes(options.projectDir)) {
    configs.push(
      ...(await loadFile(join(options.projectDir, ".kcode", "hooks.json"), "项目级", options.onWarn)),
    );
  } else {
    const exists = await fileExists(join(options.projectDir, ".kcode", "hooks.json"));
    if (exists) {
      options.onWarn?.("项目存在 .kcode/hooks.json 但项目未受信任，已忽略（/trust 可添加信任）");
    }
  }
  return configs;
}

/** 把项目路径写入受信任清单（已存在则保持幂等） */
export async function trustProject(projectDir: string, trustFile: string): Promise<void> {
  const trusted = await readTrustedProjects(trustFile);
  if (!trusted.includes(projectDir)) {
    trusted.push(projectDir);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(trustFile), { recursive: true });
    await writeFile(trustFile, `${JSON.stringify(trusted, null, 2)}\n`, "utf8");
  }
}

async function readTrustedProjects(trustFile: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(trustFile, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

async function loadFile(
  path: string,
  label: string,
  onWarn?: (message: string) => void,
): Promise<HookConfig[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    onWarn?.(`${label}钩子配置不是合法 JSON（${path}）：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const parsed = HookConfigFile.safeParse(json);
  if (!parsed.success) {
    onWarn?.(`${label}钩子配置不合法（${path}）：${parsed.error.message}`);
    return [];
  }
  return parsed.data.hooks;
}

async function fileExists(path: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
