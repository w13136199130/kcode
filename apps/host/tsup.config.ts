import { defineConfig } from "tsup";

/**
 * host 的 utilityProcess 入口打包（N3-4 M1）：单文件 CJS——
 * utilityProcess.fork 直接加载。workspace 依赖必须内联（noExternal）：
 * 它们的 exports 只导出 TS 源，CJS require 解析到 .ts 会直接炸（首次 smoke 实测）。
 */
export default defineConfig({
  entry: ["src/port.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  outExtension: () => ({ js: ".cjs" }),
  bundle: true,
  // CJS 内联依赖里的 import.meta.url 会被压成 {}，createRequire(undefined) 会让 host 启动即崩。
  // tsup shims 注入可用的 importMetaUrl；不能依赖源码/tsx 路径掩盖该问题。
  shims: true,
  // 与 CLI 打包同款：workspace 依赖内联（exports 只导出 TS 源，外置 require 会炸）；
  // canvas 是 pdfjs 可选后端（运行时按需 require、缺省跳过）、@vscode/ripgrep 是二进制——都外置
  noExternal: [/^(?!canvas($|\/)|@vscode\/ripgrep($|\/))/],
  external: ["canvas", "@vscode/ripgrep"],
  sourcemap: true,
  clean: true,
});
