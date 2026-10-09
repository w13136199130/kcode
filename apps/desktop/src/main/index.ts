import { app, BrowserWindow, Menu, Notification, ipcMain } from "electron";
import { spawnHost, type HostHandle } from "./host.js";
import { runSmoke } from "./smoke.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  win.webContents.on("console-message", (_e, _level, message) => {
    process.stderr.write(`[renderer] ${message}\n`);
  });
  win.webContents.on("did-finish-load", () => {
    process.stdout.write("[main] did-finish-load → attachPort\n");
    const host = ensureHost(win);
    const port1 = host.attachPort();
    win.webContents.postMessage("kcode:host-port", null, [port1]);
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stderr.write(`[main] did-fail-load ${code} ${desc} ${url}\n`);
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
  // 系统菜单栏移除（File/Edit/View… 是开发期遗留——桌面形态走应用内控件，zcode 同款减法）
  Menu.setApplicationMenu(null);

  // 用户级配置的默认模型（renderer 建会话用；host 侧才是 key/凭证边界）
  ipcMain.handle("kcode:default-model", async () => {
    try {
      const cfg = JSON.parse(await readFile(join(homedir(), ".kcode", "config.json"), "utf8")) as {
        models?: { default?: string };
      };
      return cfg.models?.default ?? null;
    } catch {
      return null;
    }
  });
  // 默认工作目录（M2a 先 homedir；工作区选择器随 M2b）
  ipcMain.handle("kcode:default-cwd", () => homedir());

  // 系统通知（M3a）：renderer 只在「窗口失焦」时发送（去重在 renderer 侧）；
  // 通知点击 → 聚焦窗口；同时任务栏闪烁（Windows flashFrame）
  ipcMain.on("kcode:notify", (_e, payload: { title?: string; body?: string }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined && !win.isFocused()) {
      win.flashFrame(true);
    }
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: payload.title ?? "kcode",
      body: payload.body ?? "",
    });
    n.on("click", () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w !== undefined) {
        w.show();
        w.focus();
      }
    });
    n.show();
  });

  // 新建会话 = 新窗口（每窗口一 host，注 D）
  ipcMain.on("kcode:new-window", () => createMainWindow());

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
  // 诊断模式：--kcode-diag N 秒后自动退出（收集 console 输出排查 renderer 问题）
  const diagIdx = process.argv.indexOf("--kcode-diag");
  if (diagIdx !== -1) {
    const seconds = Number(process.argv[diagIdx + 1] ?? "15");
    setTimeout(() => {
      process.stdout.write("[diag] 到时自动退出\n");
      app.exit(0);
    }, seconds * 1000);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
