import { ShieldAlert, X } from "lucide-react";

/** 未信任工作区提示：与原型一致的浅色 banner + 显式信任动作。 */
export function TrustBanner(props: {
  onTrust(): void;
  onDismiss(): void;
}) {
  return (
    <div className="trust-banner" role="status">
      <span className="tb-icon" aria-hidden="true">
        <ShieldAlert size={15} strokeWidth={1.7} />
      </span>
      <div className="tb-copy">
        <strong>工作区尚未信任</strong>
        <span>AGENTS.md、规则与项目技能尚未装载。信任后对新会话生效。</span>
      </div>
      <button type="button" className="tb-action" onClick={props.onTrust}>
        信任本工作区
      </button>
      <button type="button" className="tb-close" onClick={props.onDismiss} title="关闭">
        <X size={13} strokeWidth={1.7} />
      </button>
    </div>
  );
}
