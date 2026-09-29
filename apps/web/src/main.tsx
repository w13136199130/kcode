import { createRoot } from "react-dom/client";
import { webCssTheme } from "@kcode/design";
import App from "./App.js";

// 设计令牌注入（N1-5 → Web）：从 @kcode/design 生成 CSS 变量，亮/暗色自动切换
const styleEl = document.createElement("style");
styleEl.textContent = webCssTheme();
document.head.appendChild(styleEl);

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
