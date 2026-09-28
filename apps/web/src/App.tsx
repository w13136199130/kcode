import { useHostConnection } from "./hooks/useHostConnection.js";
import { Chat } from "./components/Chat.js";

/**
 * kcode Web 客户端入口（N3-3）：
 * 从 URL 参数取中继服务器地址与令牌，建立 WebSocket 连接后进入聊天界面。
 * 默认连本地中继：ws://localhost:7300/ws?token=从 URL ?token= 取
 */
export default function App() {
  const params = new URLSearchParams(window.location.search);
  const serverUrl = params.get("server") ?? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
  const token = params.get("token") ?? "";
  const wsUrl = token !== "" ? `${serverUrl}?token=${encodeURIComponent(token)}` : serverUrl;

  const conn = useHostConnection(wsUrl);

  if (conn.status === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui" }}>
        <div style={{ textAlign: "center" }}>
          <h2>⚠ 无法连接到 kcode 中继服务器</h2>
          <p style={{ color: "#6b7280" }}>地址：{wsUrl}</p>
          <p style={{ color: "#6b7280", fontSize: "14px" }}>
            请先启动中继：<code>pnpm --filter @kcode/server start</code>，
            然后在 URL 中附加 <code>?token=启动时打印的令牌</code>
          </p>
          <button onClick={conn.connect} style={{ marginTop: "16px", padding: "8px 20px" }}>重试</button>
        </div>
      </div>
    );
  }

  return <Chat conn={conn} />;
}
