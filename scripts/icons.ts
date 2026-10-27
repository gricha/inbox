// npm run icons: renders assets/*.png from SVG in an offscreen Electron window.
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "assets");
const icon = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");

// The tray glyph: the highlighted row over two quiet ones, in one colour (macOS template images are alpha only).
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000">
  <path fill-rule="evenodd" d="M1.6 3.1 2.2 2.2 14.6 1.9 14.1 6.1 1.4 6.4zM4 3.6h5.5v1.3H4z"/>
  <rect x="3.5" y="8.6" width="9" height="1.7" rx=".85"/>
  <rect x="3.5" y="11.9" width="6" height="1.7" rx=".85" fill-opacity=".6"/>
</svg>`;

// Windows and Linux: the app icon in small, readable on light and dark taskbars.
const color = (alert: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <rect width="16" height="16" rx="3.5" fill="#1E2024"/>
  <path d="M2.4 3.4 3 2.6 13.8 2.4 13.4 6.2 2.3 6.4z" fill="#FFD84A"/>
  <rect x="4" y="3.8" width="5.5" height="1.2" rx=".6" fill="#16171A"/>
  <rect x="4" y="8.6" width="8" height="1.5" rx=".75" fill="#E8E9EB"/>
  <rect x="4" y="11.6" width="5.5" height="1.5" rx=".75" fill="#E8E9EB" fill-opacity=".55"/>
  ${alert ? `<circle cx="12.75" cy="12.75" r="3" fill="#E5484D" stroke="#1E2024" stroke-width="1"/>` : ""}
</svg>`;

const dot = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#E5484D" stroke="#FFFFFF" stroke-width="1.5"/></svg>`;

const out: [file: string, svg: string, size: number][] = [
  ["icon.png", icon, 1024],
  ["trayTemplate.png", template, 16],
  ["trayTemplate@2x.png", template, 32],
  ["tray.png", color(false), 16],
  ["tray@2x.png", color(false), 32],
  ["tray-alert.png", color(true), 16],
  ["tray-alert@2x.png", color(true), 32],
  ["overlay-alert.png", dot, 16],
];

// Sized <svg> so Chromium rasterizes the vector at the target size instead of scaling a 300x150 bitmap.
const render = `async (svg, size) => {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.replace("<svg ", '<svg width="' + size + '" height="' + size + '" '));
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d").drawImage(img, 0, 0, size, size);
  return c.toDataURL("image/png");
}`;

app.dock?.hide();
// Not a top-level await (Electron holds "ready" until this module finishes); Electron only logs a rejection, so exit or it hangs.
app
  .whenReady()
  .then(renderIcons)
  .catch((e: unknown) => {
    console.error(e);
    app.exit(1);
  });

async function renderIcons(): Promise<void> {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL("data:text/html,<!doctype html><title>icons</title>");
  for (const [file, svg, size] of out) {
    const url: unknown = await w.webContents.executeJavaScript(`(${render})(${JSON.stringify(svg)}, ${size})`);
    const png = typeof url === "string" ? url.split(",")[1] : undefined;
    if (png === undefined) throw new Error(`rendering ${file} returned ${String(url)}`);
    fs.writeFileSync(path.join(dir, file), Buffer.from(png, "base64"));
    console.log(`assets/${file} (${size}px)`);
  }
  app.quit();
}
