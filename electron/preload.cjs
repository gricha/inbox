// window.desktop for the UI (DesktopBridge in src/types.ts). Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

const version = (process.argv.find((a) => a.startsWith("--desk-version=")) ?? "").slice("--desk-version=".length);

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  version,
  status: () => ipcRenderer.invoke("desktop:status"),
});
