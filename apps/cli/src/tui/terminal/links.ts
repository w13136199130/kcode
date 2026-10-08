import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { truncateVisual, visualWidth } from "./width.js";

/**
 * OSC 8 结构化链接（N3F-1 一期，复审修订）：只覆盖结构性位置——路径是已知值
 * 零误报（工具 argsPreview、bash 三段预算 artifact 路径、后台任务日志路径），
 * 不做 assistant 正文全文扫描（误报死路，CC/OC 也不走）。
 *
 * 支持面诚实化：file:// 点击直达编辑器仅 VS Code 集成终端成立（iTerm2/WezTerm
 * 走系统默认应用，独立 WT 会丢给浏览器）——默认仅已知良好终端发射，
 * 其余 KCODE_LINKS=1 手动开；KCODE_LINKS=0 任何环境强制关（显式关闭优先）。
 *
 * 两个坑（POC 实测证实，2026-10）：string-width 5.1.2 对 ST/BEL 终止的 OSC8
 * 均计 0 宽（Ink 布局安全）；但 slice-ansi/逐簇截断会丢闭合序列造成悬空链接——
 * 因此 width.ts 的 truncateVisual 已改链接感知，所有截断经由它。
 */

const OSC8_ST = "\x1b\\";

/** OSC8 发射开关（纯函数便于单测）。KCODE_LINKS=1 为显式手动开（含管道场景——用户自己知道要什么） */
export function hyperlinksEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  const override = env["KCODE_LINKS"];
  if (override === "0") {
    return false;
  }
  if (override === "1") {
    return true;
  }
  return isTTY && env["TERM_PROGRAM"] === "vscode";
}

/** 包一层 OSC8（ST 终止符；序列零宽）。调用方保证 label 已截断——不要截断包裹后的串 */
export function osc8Link(label: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/** 宽度预算裁剪（带省略号；经链接感知的 truncateVisual，序列安全） */
export function clipVisual(text: string, budget: number): string {
  return visualWidth(text) > budget ? `${truncateVisual(text, Math.max(0, budget - 1))}…` : text;
}

/**
 * 结构化文件链接：label 即展示文本（可含行列后缀），targetPath 可相对
 * （按 process.cwd() 解析——main.tsx 启动时已 chdir 到工作区）。
 * budget 给出时先裁 label 再包序列（POC：截断包裹串必产生悬空链接）。
 */
export function formatFileLink(
  label: string,
  targetPath: string,
  opts: { line?: number; budget?: number; env?: NodeJS.ProcessEnv } = {},
): string {
  const shown = opts.budget !== undefined ? clipVisual(label, opts.budget) : label;
  if (!hyperlinksEnabled(opts.env ?? process.env)) {
    return shown;
  }
  const url = pathToFileURL(resolve(targetPath)).href + (opts.line !== undefined ? `#L${opts.line}` : "");
  return osc8Link(shown, url);
}

/** 自家工具的常量输出格式（结构位）：落盘注记与后台任务日志行——格式是我们写死的契约，非启发式扫描 */
const STRUCTURED_PATH_RULES: Array<{ re: RegExp; build: (path: string, env: NodeJS.ProcessEnv) => string }> = [
  {
    // output-collector：…（输出共 N 字符，中间省略；完整日志已保存：<path>；以下为末尾）
    re: /(完整日志已保存：)([^；\n]+)(；)/g,
    build: (p, env) => formatFileLink(p, p, { env }),
  },
  {
    // bash.ts 后台任务终态行：后台任务 b1 完成：<cmd> · 日志 <path>
    re: /(· 日志 )(.+)$/gm,
    build: (p, env) => formatFileLink(p, p, { env }),
  },
];

/** 工具输出/摘要里的结构位路径链接化（展示层变换——工具输出原文给模型，不掺序列） */
export function linkifyStructuredPaths(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!hyperlinksEnabled(env)) {
    return text;
  }
  let out = text;
  for (const rule of STRUCTURED_PATH_RULES) {
    out = out.replace(rule.re, (_m, pre: string, p: string, post?: string) =>
      `${pre}${rule.build(p.trim(), env)}${post ?? ""}`,
    );
  }
  return out;
}
