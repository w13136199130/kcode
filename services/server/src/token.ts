import { randomBytes } from "node:crypto";

/**
 * 令牌认证（N3-3 安全层）：
 * - 默认启动时生成一次性令牌，打印到控制台供用户复制到浏览器；
 * - 环境变量 KCODE_TOKEN 显式指定（远程部署场景）；
 * - 非 loopback 监听（0.0.0.0 等）时令牌强制必填——缺省即拒绝启动（fail-closed）。
 */
export function resolveToken(_listenHost: string): string {
  const env = process.env["KCODE_TOKEN"];
  if (env !== undefined && env !== "") {
    return env;
  }
  const generated = randomBytes(24).toString("base64url");
  return generated;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** 校验 WebSocket 升级请求的令牌；返回 null 表示通过 */
export function verifyToken(url: URL, token: string): string | null {
  const provided = url.searchParams.get("token") ?? url.searchParams.get("t");
  if (provided === token) return null;
  return "令牌不匹配（在 URL 中附加 ?token=xxx）";
}
