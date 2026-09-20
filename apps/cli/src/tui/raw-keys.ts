import { useEffect, useRef } from "react";

/**
 * 自建 raw 按键层：直读 process.stdin 数据流解析特殊键（方向键/回车/Esc/Tab/Ctrl+C）。
 * 动机：不同 Windows 终端（conhost/WT/VSCode）与输入法环境下，Ink 的按键解析层
 * 未必按预期送达；字符类按键仍走 Ink（TextInput 正常），特殊键统一走这里。
 * 同时兼容 CSI（\x1b[A）与 SS3（\x1bOA）两种方向键序列。
 */

export interface RawKey {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  enter: boolean;
  esc: boolean;
  tab: boolean;
  backspace: boolean;
  ctrlC: boolean;
}

const NONE: RawKey = {
  up: false,
  down: false,
  left: false,
  right: false,
  enter: false,
  esc: false,
  tab: false,
  backspace: false,
  ctrlC: false,
};

const keyOf = (patch: Partial<RawKey>): RawKey => ({ ...NONE, ...patch });

/** 解析一个数据块为零或多个按键事件（纯函数，供测试） */
export function parseKeyChunk(chunk: string): RawKey[] {
  const out: RawKey[] = [];
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
      out.push(keyOf({ up: true }));
      i += 3;
    } else if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
      out.push(keyOf({ down: true }));
      i += 3;
    } else if (rest.startsWith("\x1b[C") || rest.startsWith("\x1bOC")) {
      out.push(keyOf({ right: true }));
      i += 3;
    } else if (rest.startsWith("\x1b[D") || rest.startsWith("\x1bOD")) {
      out.push(keyOf({ left: true }));
      i += 3;
    } else if (rest.startsWith("\r") || rest.startsWith("\n")) {
      out.push(keyOf({ enter: true }));
      i += 1;
    } else if (rest.startsWith("\t")) {
      out.push(keyOf({ tab: true }));
      i += 1;
    } else if (rest.startsWith("\x7f") || rest.startsWith("\b")) {
      out.push(keyOf({ backspace: true }));
      i += 1;
    } else if (rest.startsWith("\x03")) {
      out.push(keyOf({ ctrlC: true }));
      i += 1;
    } else if (rest.startsWith("\x1b")) {
      // 裸 ESC（或无法识别的转义序列按 ESC 处理；\x1b\x1b 只记一次）
      out.push(keyOf({ esc: true }));
      i += rest.startsWith("\x1b\x1b") ? 2 : 1;
    } else {
      // 普通字符：跳过整个块（文本输入归 Ink/TextInput 管）
      i += rest.length;
    }
  }
  return out;
}

type Handler = (key: RawKey) => void;

let installed = false;
const handlers = new Set<Handler>();

function install(): void {
  if (installed || process.stdin.isTTY !== true) {
    return;
  }
  installed = true;
  process.stdin.on("data", (chunk: Buffer) => {
    // Ink 开启 raw mode 后此处才可能收到；逐块解析分发
    for (const key of parseKeyChunk(chunk.toString("utf8"))) {
      for (const handler of handlers) {
        handler(key);
      }
    }
  });
}

/**
 * 订阅 raw 特殊键；active=false 时不接收。
 * handler 用 ref 持有最新闭包，避免每次渲染重挂监听。
 */
export function useRawKeys(handler: Handler, active: boolean): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) {
      return;
    }
    install();
    const fn: Handler = (key) => ref.current(key);
    handlers.add(fn);
    return () => {
      handlers.delete(fn);
    };
  }, [active]);
}
