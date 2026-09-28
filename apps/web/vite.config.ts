import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 代理 WebSocket 到中继服务器（开发态——浏览器连 5173，Vite 转发到 7300）
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:7300",
        ws: true,
      },
    },
  },
});
