import { app, BrowserWindow } from "electron";
import { spawnHost, type HostHandle } from "./host.js";
import { runSmoke } from "./smoke.js";

/**
 * kcode 桌面主进程（N3-4 M1）：窗口 + 每窗口一个 utilityProcess host。
 * 安全边界（§8.4g）：contextIsolation、无 nodeIntegration；preload 只暴露端口桥。
 * --kcode-smoke：无窗口自动化验收（hello → session/create → submit → session_end）。
 */

const isSmoke = process.argv.includes("--kcode-smoke");

// 每窗口一个 host；窗口关闭 → 优雅退出
const hostsByWindow = new Map<number, HostHandle>();

/** 窗口首次加载时备好 host（懒建——did-finish-load 统一入口，reload 只重挂不重建） */
function ensureHost(win: BrowserWindow): HostHandle {
  const existing = hostsByWindow.get(win.webContents.id);
  if (existing !== undefined) return existing;
  const host = spawnHost((code) => {
    hostsByWindow.delete(win.webContents.id);
    if (!win.isDestroyed()) {
      win.webContents.send("kcode:host-exit", code);
    }
  });
  hostsByWindow.set(win.webContents.id, host);
  return host;
}

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    title: "kcode",
    webPreferences: {
      preload: joinPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      sandbox: false, // renderer 走 vite/dev 加载；sandbox 化随 M3 打包加载源一并定（复审④）
    },
  });

  // host 生命周期绑定**窗口**而非 renderer 加载周期（§8.4g 复审①）：
  // 每次加载完成（含 reload）都重挂新 MessageChannelMain 到同一 host，会话不动
  win.webContents.on("did-finish-load", () => {
    const host = ensureHost(win);
    const port1 = host.attachPort();
    win.webContents.postMessage("kcode:host-port", null, [port1]);
  });

  win.on("closed", () => {
    const h = hostsByWindow.get(win.webContents.id);
    hostsByWindow.delete(win.webContents.id);
    void h?.dispose();
  });

  const devUrl = process.env["KCODE_DESKTOP_DEV_URL"];
  if (devUrl !== undefined && devUrl !== "") {
    void win.loadURL(devUrl);
  } else {
    // 打包态：M3 随加载源（自定义协议 vs file://）定稿；M1 先回落 vite build 产物
    void win.loadFile(joinRendererIndex());
  }
}

function joinPreload(): string {
  return `${__dirname}/preload.cjs`;
}

function joinRendererIndex(): string {
  return `${__dirname}/renderer/index.html`;
}

app.whenReady().then(() => {
  if (isSmoke) {
    void runSmoke()
      .then((ok) => app.exit(ok ? 0 : 1))
      .catch((err) => {
        process.stderr.write(`[smoke] ${err instanceof Error ? err.stack : String(err)}\n`);
        app.exit(1);
      });
    return;
  }
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
