import { render } from "react-dom/client";
import { StrictMode } from "react";
import { Chat } from "@web/components/Chat.js";
import { useDesktopConnection } from "./hooks/useDesktopConnection.js";

/**
 * kcode 桌面 renderer 入口（N3-4 M1）：复用 Web 客户端的 Chat 组件层
 * （@web 别名直连 apps/web/src，§8.4g 取舍①），仅替换连接层——
 * WebSocket → preload 转交的 MessagePort（帧协议同 host-protocol）。
 */
function DesktopApp() {
  const conn = useDesktopConnection();
  if (conn.status === "error") {
    return <div style={{ padding: 24, fontFamily: "system-ui" }}>⚠ 宿主连接失败：{conn.error}</div>;
  }
  if (conn.status === "closed") {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <p>宿主进程已退出（会话随之结束）。</p>
        <p style={{ color: "#6b7280" }}>关闭本窗口再开新窗口即可启动新会话。</p>
      </div>
    );
  }
  return <Chat conn={conn} />;
}

render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
  document.getElementById("root")!,
);
