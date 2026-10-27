import { defineConfig } from "@playwright/test";

/** D0-09：桌面 E2E——Electron 项目不下载浏览器，直接驱动打包后的 main/preload/renderer */
export default defineConfig({
  testDir: "./test/e2e",
  // CI 慢机（2 核 windows runner）余量：单测 120s
  timeout: 120_000,
  workers: 1,
  // Electron 树杀/端口清理在 Windows 上偶发慢一拍；失败重跑一次，避免稳定回归被单次资源抖动误杀。
  retries: 1,
  // github reporter：失败以 check-run 注解上报（匿名 API 可读——排查 CI 失败不依赖仓库管理权限）
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: { trace: "retain-on-failure" },
});
