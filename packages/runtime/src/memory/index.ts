/**
 * 记忆三层（§5.3）：会话内压缩（core/context 已实现）→ 项目/用户级 markdown（AGENTS.md 同构）
 * → 长期记忆（sqlite-vec，P4 后评估）。P2 落地文件读写实现。
 */
export interface MemoryLayer {
  load(scope: "project" | "user"): Promise<string>;
  save(scope: "project" | "user", content: string): Promise<void>;
}
