import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SandboxPtySession } from "@kcode/sandbox";
import { stripEscapes } from "./sanitize.js";

/**
 * 基础交互式 PTY 面板（不是完整终端模拟器）：
 * - 转发常用键（Enter/Tab/Backspace/Esc/方向键/Ctrl+letter）；
 * - Ctrl+] 关闭；
 * - 原始 ANSI 做安全剥离后按行展示，光标移动/全屏 TUI 不保证还原。
 *
 * 注意：Windows srt 的 exec 使用非交互 desktop + UI lockdown，无法承载 stdin；
 * 当前 /terminal 明确以“不受 srt 保护”的普通 PTY 运行，避免假装沙箱。
 */
export function TerminalPanel(props: {
  session: SandboxPtySession;
  /** true = MXC 受保护 PTY；false = 普通 PTY（不受 srt 保护） */
  protectedMode?: boolean;
  onClose(): void;
}) {
  const [lines, setLines] = useState<string[]>([
    props.protectedMode === true
      ? "MXC PTY 已启动（受保护）…"
      : "PTY 已启动（不受 srt 沙箱保护）…",
  ]);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const append = (chunk: string): void => {
      const clean = stripEscapes(chunk).replace(/\r/g, "");
      setLines((previous) => {
        const merged = `${previous.join("\n")}${clean}`.split("\n");
        return merged.slice(-18);
      });
    };
    const offData = props.session.onData(append);
    const offExit = props.session.onExit((code) => {
      setExited(true);
      setLines((previous) => [...previous, `（PTY 进程退出 ${code}；Ctrl+] 关闭）`].slice(-18));
    });
    return () => {
      offData();
      offExit();
    };
  }, [props.session]);

  useInput((input, key) => {
    if (input === "\u001d" || (key.ctrl && input === "]")) {
      props.session.kill();
      props.onClose();
      return;
    }
    if (key.return) props.session.write("\r");
    else if (key.backspace || key.delete) props.session.write("\x7f");
    else if (key.escape) props.session.write("\x1b");
    else if (key.tab) props.session.write("\t");
    else if (key.upArrow) props.session.write("\x1b[A");
    else if (key.downArrow) props.session.write("\x1b[B");
    else if (key.rightArrow) props.session.write("\x1b[C");
    else if (key.leftArrow) props.session.write("\x1b[D");
    else if (input !== "") props.session.write(input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="yellow">
        {props.protectedMode === true ? "MXC 交互终端（受保护）" : "PTY 交互终端（不受 srt 保护）"}
      </Text>
      <Text dimColor>Ctrl+] 退出 · 输出按行保留最近 18 行</Text>
      <Text>{lines.join("\n")}</Text>
      {!exited && <Text dimColor>输入会直接发送到 shell</Text>}
    </Box>
  );
}
