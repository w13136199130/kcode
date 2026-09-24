import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";

/**
 * 文件检查点：write/edit 执行前保存目标文件的前像；
 * 回退 = 逆序恢复前像（不存在的文件回退 = 删除）。
 * bash 等命令造成的外部改动无法快照（与 Claude Code 检查点同样的边界）。
 *
 * 检查点随会话持久化：条目清单 manifest.json 与快照文件一起落盘，
 * 重启后经 open() 重新装载，仍可列出/恢复此前的检查点（不再「关闭即 rm」）。
 */

/** 清单文件名：条目序列化后与快照文件同目录落盘 */
const MANIFEST = "manifest.json";

export interface CheckpointEntry {
  callId: string;
  /** 目标文件绝对路径 */
  path: string;
  /** 前像文件绝对路径（existed=false 时无前像文件，回退语义为删除） */
  snapshotPath?: string;
  existed: boolean;
}

/** 落盘清单形状：与内存条目一一对应 */
interface Manifest {
  entries: CheckpointEntry[];
}

export class CheckpointStore {
  readonly #entries: CheckpointEntry[] = [];
  readonly #byCallId = new Map<string, CheckpointEntry>();

  private constructor(private readonly dir: string) {}

  /** 打开（或新建）检查点目录；目录已带清单时装载既有条目，供重启后回退 */
  static async open(dir: string): Promise<CheckpointStore> {
    const store = new CheckpointStore(dir);
    await store.#load();
    return store;
  }

  /** 装载清单：目录无清单或清单损坏时按空目录处理（首次打开/异常降级） */
  async #load(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, MANIFEST), "utf8");
      const manifest = JSON.parse(raw) as Manifest;
      for (const entry of manifest.entries ?? []) {
        this.#entries.push(entry);
        this.#byCallId.set(entry.callId, entry);
      }
    } catch {
      // 无清单或损坏：视为空目录
    }
  }

  /** 清单落盘：每次快照后调用，保证条目在重启后可见 */
  async #persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const manifest: Manifest = { entries: [...this.#entries] };
    await writeFile(join(this.dir, MANIFEST), JSON.stringify(manifest), "utf8");
  }

  /** 写前快照：记录目标文件当前内容（不存在也记录——回退时删除） */
  async snapshot(callId: string, path: string): Promise<void> {
    const existed = existsSync(path);
    const entry: CheckpointEntry = { callId, path, existed };
    if (existed) {
      await mkdir(this.dir, { recursive: true });
      const snapshotPath = join(this.dir, `${this.#entries.length}-${basename(path)}`);
      await copyFile(path, snapshotPath);
      entry.snapshotPath = snapshotPath;
    }
    this.#entries.push(entry);
    this.#byCallId.set(callId, entry);
    await this.#persist();
  }

  get(callId: string): CheckpointEntry | undefined {
    return this.#byCallId.get(callId);
  }

  /** 全部检查点条目（按记录顺序） */
  list(): CheckpointEntry[] {
    return [...this.#entries];
  }

  /** 按记录逆序恢复（后写入的先回滚）；返回恢复的文件数 */
  async restore(callIds: string[]): Promise<number> {
    const targets = new Set(callIds);
    let restored = 0;
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i]!;
      if (!targets.has(entry.callId)) continue;
      if (entry.existed && entry.snapshotPath !== undefined) {
        try {
          await writeFile(entry.path, await readFile(entry.snapshotPath, "utf8"), "utf8");
        } catch {
          // 前像文件缺失：跳过该项，避免把目标文件写空
          continue;
        }
      } else if (!entry.existed && existsSync(entry.path)) {
        await rm(entry.path, { force: true });
      }
      restored++;
    }
    return restored;
  }

  /** 显式清理整个检查点目录（会话被删除时调用；正常关闭不再清理，以支持重启后回退） */
  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/**
 * 写类工具装饰：执行前快照目标文件（write/edit）。
 * 快照失败不阻断工具执行（检查点是尽力而为的回退保障）。
 */
export function withFileCheckpoints(
  tool: Tool,
  store: CheckpointStore,
  resolvePath: (path: string, ctx: ToolContext) => string,
): Tool {
  if (tool.definition.name !== "write" && tool.definition.name !== "edit") {
    return tool;
  }
  return {
    definition: tool.definition,
    async execute(input, ctx): Promise<ToolOutput> {
      const args = (input ?? {}) as { path?: unknown };
      if (typeof args.path === "string" && args.path !== "") {
        try {
          await store.snapshot(ctx.callId ?? `snap_${Date.now()}`, resolvePath(args.path, ctx));
        } catch {
          // 快照失败不阻断执行
        }
      }
      return tool.execute(input, ctx);
    },
  };
}
