import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SUBAGENT_TYPES } from "@kcode/contracts";
import { parseAgentMd, type ParsedAgent } from "./parse.js";

export interface AgentSource {
  /** 子代理定义根目录：其下每个 .md 文件是一个子代理 */
  dir: string;
  source: "project" | "user";
}

export interface DiscoveredAgent extends ParsedAgent {
  source: AgentSource["source"];
}

/**
 * 子代理定义库（B1）：按 roots 顺序扫描 .kcode/agents/*.md，同名先见者胜
 * （project > user）；保留名（general-purpose / explore）不可覆盖。
 * 单个文件解析失败不阻断整体，收集告警。
 */
export class AgentLibrary {
  readonly #agents = new Map<string, DiscoveredAgent>();

  static async open(roots: AgentSource[], onWarn?: (message: string) => void): Promise<AgentLibrary> {
    const library = new AgentLibrary();
    for (const root of roots) {
      let entries: Dirent[];
      try {
        entries = await readdir(root.dir, { withFileTypes: true });
      } catch {
        continue; // 目录不存在视为无定义
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const name = entry.name.slice(0, -3);
        if (!/^[a-z0-9][a-z0-9-_.]{1,63}$/.test(name)) {
          onWarn?.(`子代理文件名 ${entry.name} 不合法（小写字母/数字/-/_/.），已忽略`);
          continue;
        }
        if ((BUILTIN_SUBAGENT_TYPES as readonly string[]).includes(name)) {
          onWarn?.(`子代理 ${name} 与内置类型同名，已忽略（内置类型不可覆盖）`);
          continue;
        }
        let text: string;
        try {
          text = await readFile(join(root.dir, entry.name), "utf8");
        } catch {
          continue;
        }
        const parsed = parseAgentMd(name, text);
        if (!parsed.ok) {
          onWarn?.(`子代理 ${name} 解析失败：${parsed.error}（${root.source}）`);
          continue;
        }
        if (!library.#agents.has(name)) {
          library.#agents.set(name, { ...parsed.agent, source: root.source });
        }
      }
    }
    return library;
  }

  list(): { name: string; description: string; source: string }[] {
    return [...this.#agents.values()].map((a) => ({
      name: a.manifest.name,
      description: a.manifest.description,
      source: a.source,
    }));
  }

  get(name: string): DiscoveredAgent | undefined {
    return this.#agents.get(name);
  }
}
