import { useEffect } from "react";

/**
 * 终端标题栏进度（N3F-2，对标 CC）：OSC 0 写标题，busy/活动标签变化时更新，
 * 空闲与卸载复位为 "kcode"（终端不自动还原标题，常量复位即可）。
 * 逻辑全在本模块——App 只挂一行 useTerminalTitle（行数红线）。
 * 门：stdout 非 TTY 不写（管道/CI 不产生控制序列）；KCODE_TITLE=0 显式关闭。
 */

export interface TitleSink {
  write(text: string): void;
  isTTY?: boolean;
}

/** 写一条 OSC 0 标题序列（纯副作用，门与序列在此——单测直接喂假 sink/env） */
export function writeTerminalTitle(
  text: string,
  sink: TitleSink = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env["KCODE_TITLE"] === "0") {
    return;
  }
  if (sink.isTTY !== true) {
    return;
  }
  sink.write(`\x1b]0;${text}\x07`);
}

/** TUI 挂载点：busy 或活动标签变化即写；空闲复位 kcode；卸载复位 kcode */
export function useTerminalTitle(busy: boolean, activity: string): void {
  useEffect(() => {
    writeTerminalTitle(busy ? `kcode ⏳ ${activity}` : "kcode");
  }, [busy, activity]);
  useEffect(() => () => writeTerminalTitle("kcode"), []);
}
