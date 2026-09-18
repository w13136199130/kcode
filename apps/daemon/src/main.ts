/**
 * apps/daemon（§4.1 唯一组装点）。P3 落地：
 * - DI 组装：开 SQLite（WAL + worker）注入各模块；
 * - 本地 API：UDS ~/.kcode/daemon.sock / Windows named pipe 优先，TCP 回环兜底三件套（§5.6.2）；
 * - transport / scheduler 启动；自更新（TUF 验签 → 原子替换 → 健康检查回滚，§5.6.3）；
 * - kill switch：kcode halt（§6）。
 */
console.log("kcode daemon — P3 落地（见 ARCHITECTURE.md §9）");
