import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HookConfig, HookConfigFile, type HookConfig as HookConfigType, type HookEventName } from "@kcode/contracts";

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
/** 带来源标的钩子（N3I-7 /hooks 查看：区分用户级/项目级；source 不参与执行） */
export type SourcedHookConfig = HookConfigType & { source: "user" | "project" | "plugin"; plugin?: string };

/** 3-15：CC 事件名 → 内部事件名 */
const CC_EVENTS: Record<string, HookEventName> = {
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  UserPromptSubmit: "user_prompt_submit",
  PreCompact: "pre_compact",
  SessionStart: "session_start",
  Stop: "stop",
};
const TOOL_EVENTS = new Set<HookEventName>(["pre_tool_use", "post_tool_use"]);
const ALLOWED_TOP = new Set(["hooks"]);
const ALLOWED_ENTRY = new Set(["event", "command", "matcher", "cwd", "timeoutMs", "failClosed"]);
const ALLOWED_CC_GROUP = new Set(["matcher", "hooks", "command"]);
const ALLOWED_CC_HOOK = new Set(["type", "command", "timeout", "timeoutMs", "failClosed", "matcher"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function warnUnknown(record: Record<string, unknown>, allowed: Set<string>, where: string, warnings: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      warnings.push(`${where} 含未知键 "${key}"（已忽略，不影响加载）`);
    }
  }
}

/**
 * 3-15：把两种配置形态归一化为内部 HookConfig[]：
 * - 自有形态：`{ hooks: [{ event, command, matcher?, timeoutMs?, failClosed? }] }`
 * - CC 形态：`{ hooks: { PreToolUse: [{ matcher, hooks: [{ type:"command", command, timeout }] }] } }`
 * 未知键只告警不拒绝（条目粒度：坏条目跳过、好条目继续加载）。
 */
export function normalizeHookJson(json: unknown): { hooks: HookConfigType[]; warnings: string[] } {
  const warnings: string[] = [];
  const parsedRoot = HookConfigFile.safeParse(json);
  if (!parsedRoot.success) {
    warnings.push("钩子配置根节点不是对象，已忽略");
    return { hooks: [], warnings };
  }
  const root = parsedRoot.data as Record<string, unknown>;
  warnUnknown(root, ALLOWED_TOP, "顶层", warnings);
  const raw = root["hooks"];
  if (Array.isArray(raw)) {
    return { hooks: normalizeOwnArray(raw, warnings), warnings };
  }
  const cc = asRecord(raw);
  if (cc !== null) {
    return { hooks: normalizeCcMap(cc, warnings), warnings };
  }
  if (raw !== undefined) {
    warnings.push("hooks 必须是数组（自有形态）或对象（CC 形态），已忽略");
  }
  return { hooks: [], warnings };
}

function normalizeOwnArray(items: unknown[], warnings: string[]): HookConfigType[] {
  const hooks: HookConfigType[] = [];
  items.forEach((item, index) => {
    const where = `条目 #${index + 1}`;
    const record = asRecord(item);
    if (record === null) {
      warnings.push(`${where} 不是对象，已跳过`);
      return;
    }
    warnUnknown(record, ALLOWED_ENTRY, where, warnings);
    const parsed = HookConfig.safeParse(record);
    if (!parsed.success) {
      warnings.push(`${where} 不合法（${parsed.error.issues[0]?.message ?? "未知原因"}），已跳过`);
      return;
    }
    if (parsed.data.matcher !== undefined && !TOOL_EVENTS.has(parsed.data.event)) {
      warnings.push(`${where} 的 matcher 仅对工具事件生效（${parsed.data.event} 已忽略 matcher）`);
    }
    hooks.push(parsed.data);
  });
  return hooks;
}

function normalizeCcMap(map: Record<string, unknown>, warnings: string[]): HookConfigType[] {
  const hooks: HookConfigType[] = [];
  for (const [ccEvent, groups] of Object.entries(map)) {
    const event = CC_EVENTS[ccEvent];
    if (event === undefined) {
      warnings.push(`未知事件 "${ccEvent}"（已跳过；CC 支持 PreToolUse/PostToolUse/UserPromptSubmit/PreCompact/SessionStart/Stop）`);
      continue;
    }
    if (!Array.isArray(groups)) {
      warnings.push(`${ccEvent} 必须是数组，已跳过`);
      continue;
    }
    groups.forEach((group, groupIndex) => {
      const where = `${ccEvent} #${groupIndex + 1}`;
      const record = asRecord(group);
      if (record === null) {
        warnings.push(`${where} 不是对象，已跳过`);
        return;
      }
      warnUnknown(record, ALLOWED_CC_GROUP, where, warnings);
      const matcher = typeof record["matcher"] === "string" ? record["matcher"] : undefined;
      if (matcher !== undefined && !TOOL_EVENTS.has(event)) {
        warnings.push(`${where} 的 matcher 仅对工具事件生效（${event} 已忽略 matcher）`);
      }
      // 容错：group 直接给 command（非 CC 标准但常见手写）
      const direct = typeof record["command"] === "string" ? record["command"] : undefined;
      const inner = Array.isArray(record["hooks"]) ? record["hooks"] : direct !== undefined ? [{ command: direct }] : [];
      if (inner.length === 0) {
        warnings.push(`${where} 没有 command，已跳过`);
        return;
      }
      inner.forEach((item, index) => {
        const hookWhere = `${where} 钩子 #${index + 1}`;
        const entry = asRecord(item);
        if (entry === null) {
          warnings.push(`${hookWhere} 不是对象，已跳过`);
          return;
        }
        warnUnknown(entry, ALLOWED_CC_HOOK, hookWhere, warnings);
        if (entry["type"] !== undefined && entry["type"] !== "command") {
          warnings.push(`${hookWhere} 的 type=${String(entry["type"])} 暂不支持（仅 command），已跳过`);
          return;
        }
        const command = typeof entry["command"] === "string" ? entry["command"] : "";
        if (command === "") {
          warnings.push(`${hookWhere} 缺少 command，已跳过`);
          return;
        }
        const timeoutMs =
          typeof entry["timeoutMs"] === "number"
            ? entry["timeoutMs"]
            : typeof entry["timeout"] === "number"
              ? Math.round(entry["timeout"] * 1000)
              : undefined;
        const candidate = {
          event,
          command,
          ...(matcher !== undefined && TOOL_EVENTS.has(event) ? { matcher } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(entry["failClosed"] === true ? { failClosed: true } : {}),
        };
        const parsed = HookConfig.safeParse(candidate);
        if (!parsed.success) {
          warnings.push(`${hookWhere} 不合法（${parsed.error.issues[0]?.message ?? "未知原因"}），已跳过`);
          return;
        }
        hooks.push(parsed.data);
      });
    });
  }
  return hooks;
}

export async function loadHookConfigs(options: HookLoadOptions): Promise<SourcedHookConfig[]> {
  const configs: SourcedHookConfig[] = [];
  configs.push(
    ...(await loadFile(join(options.userDir, "hooks.json"), "用户级", options.onWarn)).map((h) => ({
      ...h,
      source: "user" as const,
    })),
  );

  const trusted = await readTrustedProjects(options.trustFile);
  if (trusted.includes(options.projectDir)) {
    configs.push(
      ...(await loadFile(join(options.projectDir, ".kcode", "hooks.json"), "项目级", options.onWarn)).map(
        (h) => ({ ...h, source: "project" as const }),
      ),
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
/** 项目是否已在受信任清单（N3I-4：/trust 已信任后从菜单隐藏） */
export async function isProjectTrusted(projectDir: string, trustFile: string): Promise<boolean> {
  return (await readTrustedProjects(trustFile)).includes(projectDir);
}

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

async function loadFile(path: string, label: string, onWarn?: (message: string) => void): Promise<HookConfigType[]> {
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
  const { hooks, warnings } = normalizeHookJson(json);
  for (const warning of warnings) {
    onWarn?.(`${label}钩子配置：${warning}（${path}）`);
  }
  return hooks;
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
