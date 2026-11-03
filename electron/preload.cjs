// window.desktop for the UI (DesktopBridge in src/types.ts). Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

const version = (process.argv.find((a) => a.startsWith("--desk-version=")) ?? "").slice("--desk-version=".length);

// This device's theme as the app keeps it: a string, or null when none was picked in the app.
const theme = () => {
  const t = /** @type {unknown} */ (ipcRenderer.sendSync("desktop:theme"));
  return typeof t === "string" ? t : null;
};

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  version,
  theme: theme(), // index.html applies it before the first paint
  setTheme: (id) => ipcRenderer.invoke("desktop:set-theme", id),
  status: () => ipcRenderer.invoke("desktop:status"),
});
