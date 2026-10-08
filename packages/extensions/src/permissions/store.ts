import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createServiceLogger } from "@kcode/shared";
import { matchTool } from "./engine.js";
import { formatGrantPattern, matchGrantPattern, parseGrantPattern, type GrantPattern } from "./grant-patterns.js";

const log = createServiceLogger("permissions.store");

/**
 * 持久放行文件结构：按项目绝对路径分键（克隆来的仓库无法伪造自己的放行清单）。
 * 条目两形态（N3I-5 v2）：字符串（v1 工具名 = 整工具放行，兼容读取）与
 * `{ tool, content? }` 对象（参数级：content 三档匹配，见 grant-patterns.ts）。
 */
interface PermissionsFile {
  v: 1;
  projects: Record<string, Array<string | GrantPattern>>;
}

/**
 * 项目级持久放行库（ask 应答 scope=project 的落盘实现）。
 *
 * 设计要点：
 * - 文件在用户级 kcode 主目录（~/.kcode/permissions.json），按项目路径分键——
 *   与 trusted-projects.json 同一信任边界：项目目录内的文件不可自授放行。
 * - matches() 每次重读文件：放行在 ask 时点查询（而非引擎层注入），
 *   plan 档的 deny 规则先生效，持久放行只跳过询问，不会打穿只读姿态；
 *   同时其他会话/前端对文件的修改即时可见。
 * - 写入为读-改-写整文件；单用户低频操作，不做并发控制。
 * - 文件损坏按空处理并告警一次（不主动覆写，直到下一次成功写入）。
 */
export class ProjectGrantStore {
  private constructor(
    private readonly file: string,
    private readonly projectDir: string,
    private warned = false,
  ) {}

  static open(file: string, projectDir: string): ProjectGrantStore {
    return new ProjectGrantStore(file, projectDir);
  }

  /** 当前项目是否持久放行了该调用（工具名 + 可选参数主体——bash 命令/文件路径） */
  async matches(toolName: string, subject?: string): Promise<boolean> {
    const patterns = (await this.readRaw()).map((entry) => normalizeEntry(entry));
    return patterns.some((p) => matchGrantPattern(p, toolName, subject));
  }

  /** 当前项目的持久放行清单（展示形态：`bash:npm install:*` / `write`） */
  async list(): Promise<string[]> {
    const entries = (await this.readRaw()).map((entry) => normalizeEntry(entry));
    return entries.map((p) => formatGrantPattern(p));
  }

  /** 追加一条持久放行（幂等；立即落盘）。参数级模式传对象，整工具传字符串 */
  async grant(entry: string | GrantPattern): Promise<void> {
    const normalized = normalizeEntry(entry);
    const key = JSON.stringify(normalized);
    const doc = await this.read();
    const current = doc.projects[this.projectDir] ?? [];
    const exists = current.some((e) => JSON.stringify(normalizeEntry(e)) === key);
    if (!exists) {
      doc.projects[this.projectDir] = [...current, normalized];
      await this.write(doc);
    }
  }

  /** 清空当前项目的持久放行，返回清除的条数 */
  async clear(): Promise<number> {
    const doc = await this.read();
    const current = doc.projects[this.projectDir] ?? [];
    if (current.length === 0) {
      return 0;
    }
    delete doc.projects[this.projectDir];
    await this.write(doc);
    return current.length;
  }

  private async readRaw(): Promise<Array<string | GrantPattern>> {
    return (await this.read()).projects[this.projectDir] ?? [];
  }

  private async read(): Promise<PermissionsFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return { v: 1, projects: {} };
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as PermissionsFile).v === 1 &&
        typeof (parsed as PermissionsFile).projects === "object"
      ) {
        const projects: Record<string, Array<string | GrantPattern>> = {};
        for (const [dir, entries] of Object.entries((parsed as PermissionsFile).projects)) {
          if (Array.isArray(entries)) {
            projects[dir] = entries.filter(
              (e): e is string | GrantPattern =>
                typeof e === "string" || (typeof e === "object" && e !== null && typeof (e as GrantPattern).tool === "string"),
            );
          }
        }
        return { v: 1, projects };
      }
      throw new Error("结构不符");
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        log.warn(
          `持久放行文件不是合法 JSON（${this.file}），按空处理：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { v: 1, projects: {} };
    }
  }

  private async write(doc: PermissionsFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }
}

/** 条目归一：字符串是 v1 工具名（含通配）或 v2 展示形态（`tool:content`）——统一为对象 */
function normalizeEntry(entry: string | GrantPattern): GrantPattern {
  return typeof entry === "string" ? parseGrantPattern(entry) : entry;
}
