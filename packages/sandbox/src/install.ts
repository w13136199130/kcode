/** `/sandbox install` 的结果；安装本身由 srt 的自提升进程完成（一次 UAC）。 */
export interface SandboxInstallOutcome {
  ok: boolean;
  cancelled?: boolean;
  message: string;
}

/**
 * 从 TUI 安装/修复 srt Windows 沙箱。
 *
 * 默认 `skipProfileGrant: true`：沙箱命令读不到用户 profile，风险更小。
 * 需要 profile 读时由命令显式传 `grantProfile`（`/sandbox install grant`）。
 */
export async function installSandbox(opts: { grantProfile?: boolean } = {}): Promise<SandboxInstallOutcome> {
  if (process.platform !== "win32") {
    return { ok: false, message: "srt 安装仅支持 Windows" };
  }
  try {
    const mod = await import("@anthropic-ai/sandbox-runtime");
    const result = await mod.installWindowsSandboxAsync({ skipProfileGrant: opts.grantProfile !== true });
    if (result.cancelled === true) {
      return { ok: false, cancelled: true, message: "已取消 UAC；沙箱未安装/未更新。" };
    }
    const wfp = result.wfp;
    const user = result.user;
    const lines = [
      "srt Windows 沙箱已安装。",
      `沙箱账户：${user.provisioned ? "provisioned" : "未就绪"}（${user.realUserSid ?? "unknown"}）`,
      `WFP：${wfp.state}${wfp.filters > 0 ? `，${wfp.filters} filters` : ""}`,
      opts.grantProfile === true
        ? "profile read grant：已请求（沙箱命令可读 profile；建议同时设置 KCODE_SANDBOX_DENY_READ）"
        : "profile read grant：未授予（默认更安全）",
      "下一步：设置 KCODE_SANDBOX=srt，重启 kcode，然后运行 /sandbox。",
    ];
    return { ok: true, message: lines.join("\n") };
  } catch (err) {
    return {
      ok: false,
      message: `srt 安装失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
