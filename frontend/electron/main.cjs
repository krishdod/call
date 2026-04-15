const { app, BrowserWindow, shell, desktopCapturer } = require("electron");
const path = require("path");

const isDev = !app.isPackaged;
const devUrl = process.env.ELECTRON_RENDERER_URL || "http://localhost:5173";

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Enable navigator.mediaDevices.getDisplayMedia in the renderer (Windows needs this,
  // otherwise it commonly throws NotSupportedError in packaged apps).
  win.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const first = sources?.[0];
      if (!first) {
        callback({});
        return;
      }
      // Request desktop video with explicit loopback audio.
      // On Windows, using `audio: "loopback"` is the recommended mode.
      callback({ video: first, audio: "loopback" });
    } catch {
      callback({});
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    win.loadURL(devUrl);
    return;
  }
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
