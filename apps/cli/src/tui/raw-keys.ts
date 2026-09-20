import { useEffect, useRef } from "react";

/**
 * 自建 raw 按键层：直读 process.stdin 数据流解析特殊键（方向键/回车/Esc/Tab/Ctrl+C）。
 * 动机：不同 Windows 终端（conhost/WT/VSCode）与输入法环境下，Ink 的按键解析层
 * 未必按预期送达；字符类按键仍走 Ink（TextInput 正常），特殊键统一走这里。
 * 同时兼容 CSI（\x1b[A）与 SS3（\x1bOA）两种方向键序列。
 */

export interface RawKey {
  /** 本事件伴随的可打印文本（连续字符串；特殊键事件为空串） */
  text: string;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  home: boolean;
  end: boolean;
  delete: boolean;
  enter: boolean;
  esc: boolean;
  tab: boolean;
  backspace: boolean;
  ctrlC: boolean;
}

const NONE: RawKey = {
  text: "",
  up: false,
  down: false,
  left: false,
  right: false,
  home: false,
  end: false,
  delete: false,
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
    } else if (rest.startsWith("\x1b[H") || rest.startsWith("\x1bOH") || rest.startsWith("\x1b[1~")) {
      out.push(keyOf({ home: true }));
      i += rest.startsWith("\x1b[1~") ? 4 : 3;
    } else if (rest.startsWith("\x1b[F") || rest.startsWith("\x1bOF") || rest.startsWith("\x1b[4~")) {
      out.push(keyOf({ end: true }));
      i += rest.startsWith("\x1b[4~") ? 4 : 3;
    } else if (rest.startsWith("\x1b[3~")) {
      out.push(keyOf({ delete: true }));
      i += 4;
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
      // 连续可打印字符收成一段 text 事件（字符输入统一走 raw 层，
      // 绕开部分终端/启动期 Ink useInput 送达不稳定的问题）
      let j = 0;
      while (j < rest.length) {
        const c = rest[j]!;
        if (c < " " || c === "") break;
        j += c.codePointAt(0)! > 0xffff ? 2 : 1;
      }
      if (j === 0) {
        // 不可识别的控制字符：跳过一个，避免死循环
        i += 1;
      } else {
        out.push(keyOf({ text: rest.slice(0, j) }));
        i += j;
      }
    }
  }
  return out;
}

type Handler = (key: RawKey) => void;

let installed = false;
const handlers = new Set<Handler>();
/** raw 层最近一次交付 text 的时刻：供 Ink useInput 后备通道去重（60ms 内视为同一输入） */
let lastTextAt = 0;

/** raw 层刚刚交付过字符输入吗（英文可靠；部分终端的 IME 中文块只走 Ink 通道） */
export function rawDeliveredTextRecently(): boolean {
  return Date.now() - lastTextAt < 60;
}

function install(): void {
  if (installed || process.stdin.isTTY !== true) {
    return;
  }
  installed = true;
  process.stdin.on("data", (chunk: Buffer) => {
    // Ink 开启 raw mode 后此处才可能收到；逐块解析分发
    let delivered = false;
    for (const key of parseKeyChunk(chunk.toString("utf8"))) {
      if (key.text !== "") {
        delivered = true;
      }
      for (const handler of handlers) {
        handler(key);
      }
    }
    if (delivered) {
      lastTextAt = Date.now();
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
