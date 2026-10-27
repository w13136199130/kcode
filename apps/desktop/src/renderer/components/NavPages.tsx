import { Bot, MessageSquare, Store } from "lucide-react";

/** 一级导航页标识（S1-8）：chat 为主工作区，其余为静态占位。 */
export type NavPage = "chat" | "automation" | "plugins";

/** S1-8：侧栏顶部一级导航行（对话/自动化/插件市场）。 */
export function SidebarNav({ nav, onNavChange }: { nav: NavPage; onNavChange(page: NavPage): void }) {
  return (
    <div className="d2-nav">
      <button type="button" className={nav === "chat" ? "active" : ""} onClick={() => onNavChange("chat")}>
        <MessageSquare size={13} strokeWidth={1.8} />
        对话
      </button>
      <button type="button" className={nav === "automation" ? "active" : ""} onClick={() => onNavChange("automation")}>
        <Bot size={13} strokeWidth={1.8} />
        自动化
      </button>
      <button type="button" className={nav === "plugins" ? "active" : ""} onClick={() => onNavChange("plugins")}>
        <Store size={13} strokeWidth={1.8} />
        插件市场
      </button>
    </div>
  );
}

/**
 * S1-8（F20/F21 静态占位）：「自动化 / 插件市场」一级导航空态页。
 * 只补齐整窗视觉完整度；真实功能（定时任务/市场/本地管理接线）走 S3-5 例外立项。
 */
export function NavPlaceholderPage({ page, onBack }: { page: Exclude<NavPage, "chat">; onBack: () => void }) {
  return (
    <div className="nav-placeholder-page" data-nav-page={page}>
      <div className="np-card">
        {page === "automation" ? (
          <>
            <div className="np-title">
              <Bot size={18} strokeWidth={1.8} />
              自动化
            </div>
            <p className="np-desc">还没有定时任务。定时/临时任务与模板的完整能力建设中（按例外流程单独立项）。</p>
            <div className="np-actions">
              <button type="button" disabled>
                新建定时任务
              </button>
              <button type="button" disabled>
                创建临时任务
              </button>
            </div>
            <div className="np-templates">
              <div className="np-template">⏰ 每日站会摘要 · 定时</div>
              <div className="np-template">🔁 失败测试重跑 · 触发式</div>
              <div className="np-template">📦 依赖升级周报 · 定时</div>
            </div>
          </>
        ) : (
          <>
            <div className="np-title">
              <Store size={18} strokeWidth={1.8} />
              插件市场
            </div>
            <p className="np-desc">市场功能建设中——本地插件管理优先；已安装插件可在 CLI `kcode plugin list` 查看。</p>
            <div className="np-actions">
              <button type="button" disabled>
                公开
              </button>
              <button type="button" disabled>
                社区
              </button>
              <button type="button" disabled>
                个人
              </button>
            </div>
            <div className="np-templates">
              <div className="np-template">🔌 本地插件装卸 · CLI 已支持</div>
              <div className="np-template">🛡 插件签名校验 · 规划中</div>
            </div>
          </>
        )}
        <button type="button" className="np-back" onClick={onBack}>
          ← 返回对话
        </button>
      </div>
    </div>
  );
}
