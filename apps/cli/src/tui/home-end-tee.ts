/**
 * Home/End 键回收层：Ink 的 useInput 对「具名键」（home/end）会把 input 清空，
 * 应用层拿不到——而这两个键没有别的暴露途径。
 * 做法：包裹 stdin.read（Ink 以 paused 模式 readable+read 读键），
 * 读到的原始块顺路扫描 Home/End 转义序列并分发；不改变 Ink 的任何行为。
 */
type HomeEndHandler = (key: "home" | "end") => void;

const handlers = new Set<HomeEndHandler>();
let patched = false;

const SEQUENCES: ReadonlyArray<{ seq: string; key: "home" | "end" }> = [
  { seq: "\x1b[H", key: "home" },
  { seq: "\x1bOH", key: "home" },
  { seq: "\x1b[1~", key: "home" },
  { seq: "\x1b[F", key: "end" },
  { seq: "\x1bOF", key: "end" },
  { seq: "\x1b[4~", key: "end" },
];

export function patchStdinReadForKeys(): void {
  if (patched || process.stdin.isTTY !== true) {
    return;
  }
  patched = true;
  const stdin = process.stdin as { read: (size?: number) => unknown };
  const originalRead = stdin.read.bind(stdin);
  stdin.read = (size?: number): unknown => {
    const chunk = originalRead(size);
    if (typeof chunk === "string" && chunk !== "") {
      for (const { seq, key } of SEQUENCES) {
        if (chunk.includes(seq)) {
          for (const handler of handlers) {
            handler(key);
          }
        }
      }
    }
    return chunk;
  };
}

/** 订阅 Home/End；返回取消函数 */
export function onHomeEnd(handler: HomeEndHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
