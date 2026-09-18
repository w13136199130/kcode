/**
 * skills（解析/渐进加载/统一 discover）+ hooks（事件分发/veto）+ plugins（安装同意页/seed/Sigstore 验证）
 * + permissions（allow/ask/deny 规则引擎 + 预设 + automation 模式），§4.4。
 * skills/permissions 已落地（P1-4/P2-1）；hooks/plugins P3 落地。
 */
export * from "./permissions/index.js";
export * from "./skills/index.js";
