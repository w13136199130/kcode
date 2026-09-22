import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "@kcode/contracts";

/**
 * 文件检查点（B2 /rewind）：write/edit 执行前保存目标文件的前像；
 * 回退 = 逆序恢复前像（不存在的文件回退 = 删除）。
 * bash 等命令造成的外部改动无法快照（与 Claude Code 检查点同样的边界）。
 */
export interface CheckpointEntry {
  callId: string;
  /** 目标文件绝对路径 */
  path: string;
  /** 前像文件绝对路径（existed=false 时无前像文件，回退语义为删除） */
  snapshotPath?: string;
  existed: boolean;
}

export class CheckpointStore {
  readonly #entries: CheckpointEntry[] = [];
  readonly #byCallId = new Map<string, CheckpointEntry>();
  private opened = false;

  constructor(private readonly dir: string) {}

  async #ensureDir(): Promise<void> {
    if (!this.opened) {
      await mkdir(this.dir, { recursive: true });
      this.opened = true;
    }
  }

  /** 写前快照：记录目标文件当前内容（不存在也记录——回退时删除） */
  async snapshot(callId: string, path: string): Promise<void> {
    const existed = existsSync(path);
    const entry: CheckpointEntry = { callId, path, existed };
    if (existed) {
      await this.#ensureDir();
      const snapshotPath = join(this.dir, `${this.#entries.length}-${basename(path)}`);
      await copyFile(path, snapshotPath);
      entry.snapshotPath = snapshotPath;
    }
    this.#entries.push(entry);
    this.#byCallId.set(callId, entry);
  }

  get(callId: string): CheckpointEntry | undefined {
    return this.#byCallId.get(callId);
  }

  /** 按记录逆序恢复（后写入的先回滚）；返回恢复的文件数 */
  async restore(callIds: string[]): Promise<number> {
    const targets = new Set(callIds);
    let restored = 0;
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i]!;
      if (!targets.has(entry.callId)) continue;
      if (entry.existed && entry.snapshotPath !== undefined) {
        await writeFile(entry.path, await readFile(entry.snapshotPath, "utf8"), "utf8");
      } else if (!entry.existed && existsSync(entry.path)) {
        await rm(entry.path, { force: true });
      }
      restored++;
    }
    return restored;
  }

  /** 会话关闭时清理快照目录（对标 Claude Code：检查点随会话销毁） */
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
