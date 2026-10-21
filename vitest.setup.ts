import process from "node:process";

/**
 * Ink 4 在 CI=true 时只写 Static 输出，动态帧保存在 lastOutput 里直到 unmount；
 * 大量 Ink 组件测试断言的是“运行中的帧”，在 CI 会得到空帧。
 * Ink 显式支持 CI=false 关闭该优化（ink.js: `process.env.CI === 'false' ? false : ...`），
 * 测试进程固定关闭，避免 Linux/Windows CI 上出现假失败。
 */
process.env["CI"] = "false";
