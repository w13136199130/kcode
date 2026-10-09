import { defineConfig } from "tsup";

/**
 * 桌面主进程 + preload 打包（CJS——Electron main 侧最稳形态）。
 * renderer 走 vite（见 vite.config.ts），复用 apps/web 组件层。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version as string;

export default defineConfig({
  entry: { main: "src/main/index.ts", preload: "src/preload/index.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  outExtension: () => ({ js: ".cjs" }),
  bundle: true,
  // @kcode/* 只导出 TS 源——外置的 CJS require 会炸（host 侧同病同修）；electron 本身必须外置
  define: { "process.env.KCODE_VERSION": JSON.stringify(version) },
  noExternal: [/^(?!electron($|\/))/],
  external: ["electron"],
  sourcemap: true,
  clean: false,
});
