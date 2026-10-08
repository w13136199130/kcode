import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { McpServersFile, type McpServerConfig } from "@kcode/contracts";
import { connectMcpServers } from "@kcode/tools";
import { kcodeHome } from "./bootstrap.js";

/**
 * kcode mcp（N3F-6）：MCP 服务器管理——list / add / remove / test，对标 CC `claude mcp`。
 * 镜像 doctor.ts 的 print/exit 约定（返回 bool，main 决定退出码）。
 * 写 ~/.kcode/mcp.json 前 zod 校验 + tmp/rename 原子写（防半截文件）。
 * 取舍：不做 add-json（手改文件是逃生门）；项目级 MCP 不做——能注入"启动即执行"
 * 的 stdio 命令，安全前提是 /trust 门控（同 hooks 项目级），排 N3H 之后。
 */

export interface McpCommandOptions {
  /** 配置目录（测试注入；默认 ~/.kcode） */
  home?: string;
  /** 连接探针（测试注入；默认 @kcode/tools connectMcpServers） */
  connect?: typeof connectMcpServers;
  /** 探针超时（默认 10s） */
  testTimeoutMs?: number;
}

const USAGE = [
  "用法：",
  "  kcode mcp list                          列出已配置的 MCP 服务器",
  "  kcode mcp add <name> -- <命令> [参数…]    添加 stdio 服务器（独立子进程）",
  "  kcode mcp add <name> <url> [--transport http|sse]  添加远程服务器",
  "  kcode mcp remove <name>                  移除服务器",
  "  kcode mcp test <name>                    连接探针（列举工具，10s 超时）",
].join("\n");

interface Loaded {
  servers: McpServerConfig[];
  /** 文件存在但非法：保留原样不覆盖，提示手动修复 */
  broken?: string;
}

async function loadMcpFile(file: string): Promise<Loaded> {
  if (!existsSync(file)) {
    return { servers: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    return { servers: [], broken: `mcp.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = McpServersFile.safeParse(json);
  if (!parsed.success) {
    return { servers: [], broken: `mcp.json 不符合 schema：${parsed.error.message}` };
  }
  return { servers: parsed.data.servers };
}

/** zod 校验后原子写回（tmp + rename：Node rename 在 Windows 也覆盖已存在目标；tmp 同目录保证同卷） */
async function saveMcpFile(file: string, servers: McpServerConfig[]): Promise<void> {
  const validated = McpServersFile.parse({ servers });
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** 单服务器摘要行 */
function describe(cfg: McpServerConfig): string {
  const target =
    cfg.transport === "stdio"
      ? `${cfg.command ?? ""}${cfg.args.length > 0 ? ` ${cfg.args.join(" ")}` : ""}`
      : cfg.url ?? "";
  return `${cfg.name}  [${cfg.transport}]  ${target}`;
}

export async function mcpCommand(sub: readonly string[], print: (s: string) => void, opts: McpCommandOptions = {}): Promise<boolean> {
  const file = join(opts.home ?? kcodeHome(), "mcp.json");
  const connect = opts.connect ?? connectMcpServers;
  const [action, ...rest] = sub;

  if (action === undefined || action === "help") {
    print(USAGE);
    return true;
  }

  const loaded = await loadMcpFile(file);

  if (action === "list") {
    if (loaded.broken !== undefined) {
      print(`✗ ${loaded.broken}`);
      return false;
    }
    if (loaded.servers.length === 0) {
      print("（未配置 MCP 服务器——kcode mcp add 添加）");
      return true;
    }
    print(`已配置 ${loaded.servers.length} 个 MCP 服务器：`);
    for (const cfg of loaded.servers) {
      print(`  ${describe(cfg)}`);
    }
    return true;
  }

  if (action === "add") {
    if (loaded.broken !== undefined) {
      print(`✗ ${loaded.broken}（修复后再 add——本命令不会覆盖损坏的文件）`);
      return false;
    }
    const name = rest[0];
    if (name === undefined || name === "") {
      print(`✗ add 需要 <name>${USAGE}`);
      return false;
    }
    if (loaded.servers.some((s) => s.name === name)) {
      print(`✗ 已存在同名服务器 ${name}（先 kcode mcp remove ${name}）`);
      return false;
    }
    let candidate: McpServerConfig;
    const dd = rest.indexOf("--");
    if (dd !== -1) {
      // stdio：`--` 之后是命令与参数
      const cmd = rest.slice(dd + 1);
      const command = cmd[0];
      if (command === undefined || command === "") {
        print('✗ stdio 形式需要 "-- <命令> [参数…]"');
        return false;
      }
      candidate = { name, transport: "stdio", command, args: cmd.slice(1) };
    } else if (rest[1] !== undefined && /^https?:\/\//.test(rest[1]!)) {
      // 远程：<url> + 可选 --transport http|sse（默认 http）
      const tIdx = rest.indexOf("--transport");
      const transport = tIdx !== -1 ? (rest[tIdx + 1] ?? "") : "http";
      if (transport !== "http" && transport !== "sse") {
        print(`✗ --transport 只能是 http | sse（收到 ${transport}）`);
        return false;
      }
      candidate = { name, transport, url: rest[1]!, args: [] };
    } else {
      print(`✗ add 形式不合法${USAGE}`);
      return false;
    }
    const parsed = McpServersFile.safeParse({ servers: [...loaded.servers, candidate] });
    if (!parsed.success) {
      print(`✗ 配置不合法：${parsed.error.message}`);
      return false;
    }
    await saveMcpFile(file, parsed.data.servers);
    print(`✓ 已添加 ${describe(candidate)}（写入 ${file}；kcode mcp test ${name} 验证连通）`);
    return true;
  }

  if (action === "remove") {
    if (loaded.broken !== undefined) {
      print(`✗ ${loaded.broken}`);
      return false;
    }
    const name = rest[0];
    if (name === undefined || name === "") {
      print(`✗ remove 需要 <name>${USAGE}`);
      return false;
    }
    const next = loaded.servers.filter((s) => s.name !== name);
    if (next.length === loaded.servers.length) {
      print(`✗ 未找到 ${name}（已配置：${loaded.servers.map((s) => s.name).join("、") || "无"}）`);
      return false;
    }
    await saveMcpFile(file, next);
    print(`✓ 已移除 ${name}`);
    return true;
  }

  if (action === "test") {
    const name = rest[0];
    if (name === undefined || name === "") {
      print(`✗ test 需要 <name>${USAGE}`);
      return false;
    }
    const cfg = loaded.servers.find((s) => s.name === name);
    if (cfg === undefined) {
      print(`✗ 未找到 ${name}（已配置：${loaded.servers.map((s) => s.name).join("、") || "无"}）`);
      return false;
    }
    print(`正在连接 ${describe(cfg)} …`);
    const warnings: string[] = [];
    // 竞态定时器 unref + finally clear：快速成功不让 CLI 多等 10s 才能退出
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutMs = opts.testTimeoutMs ?? 10_000;
      const sessions = await Promise.race([
        connect([cfg], { onWarn: (m) => warnings.push(m) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`连接超时（${timeoutMs}ms）`)), timeoutMs);
          timer.unref();
        }),
      ]);
      const session = sessions[0];
      if (session === undefined) {
        print(`✗ 连接失败：${warnings[0] ?? "未知原因"}`);
        return false;
      }
      const names = session.tools.map((t) => t.definition.name.replace(`mcp__${name}__`, ""));
      print(`✓ ${name} 连接成功，提供 ${names.length} 个工具：${names.slice(0, 8).join("、")}${names.length > 8 ? " …" : ""}`);
      await session.close();
      return true;
    } catch (err) {
      print(`✗ ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  print(`✗ 未知子命令 ${action}\n${USAGE}`);
  return false;
}
