const { contextBridge, desktopCapturer } = require("electron");

const api = {
  isElectron: true,
  platform: process.platform,
  async getSources() {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 }
    });
    return sources.map((s) => ({ id: s.id, name: s.name }));
  }
};

contextBridge.exposeInMainWorld("desktopMeta", {
  platform: process.platform
});

contextBridge.exposeInMainWorld("desktopCapture", api);
contextBridge.exposeInMainWorld("__vvDesktop", api);
