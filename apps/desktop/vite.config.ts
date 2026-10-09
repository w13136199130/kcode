import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * 桌面 renderer（N3-4 M1）：@web 别名直连 apps/web/src 组件层复用
 * （Chat/Dialogs/Markdown；§8.4g 取舍①——M2 后视耦合再决定抽共享包）。
 */
export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  resolve: {
    alias: {
      "@web": resolve(__dirname, "../web/src"),
    },
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
