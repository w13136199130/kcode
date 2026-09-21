import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { matchTool } from "./engine.js";

/** 持久放行文件结构：按项目绝对路径分键（克隆来的仓库无法伪造自己的放行清单） */
interface PermissionsFile {
  v: 1;
  projects: Record<string, string[]>;
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

  /** 当前项目是否持久放行了该工具（按工具名模式，复用权限规则通配语义） */
  async matches(toolName: string): Promise<boolean> {
    const patterns = await this.list();
    return patterns.some((p) => matchTool(p, toolName));
  }

  /** 当前项目的持久放行清单（文件缺失/损坏 → 空） */
  async list(): Promise<string[]> {
    const doc = await this.read();
    return doc.projects[this.projectDir] ?? [];
  }

  /** 追加一条持久放行（幂等；立即落盘） */
  async grant(toolName: string): Promise<void> {
    const doc = await this.read();
    const current = doc.projects[this.projectDir] ?? [];
    if (!current.includes(toolName)) {
      doc.projects[this.projectDir] = [...current, toolName];
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
        const projects: Record<string, string[]> = {};
        for (const [dir, patterns] of Object.entries((parsed as PermissionsFile).projects)) {
          if (Array.isArray(patterns)) {
            projects[dir] = patterns.filter((p): p is string => typeof p === "string");
          }
        }
        return { v: 1, projects };
      }
      throw new Error("结构不符");
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
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
