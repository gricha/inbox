// npm run icons: renders assets/*.png from SVG in an offscreen Electron window.
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "assets");
const icon = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");

// The tray glyph: two cards behind a front card, drawn in one colour (macOS template images are alpha only).
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000">
  <rect x="4.5" y="1.5" width="7" height="2" rx="1"/>
  <rect x="3" y="4.5" width="10" height="2" rx="1"/>
  <path fill-rule="evenodd" d="M2.5 7.5h11a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13V9a1.5 1.5 0 0 1 1.5-1.5zM4 10.25h8v1.5H4z"/>
</svg>`;

// Windows and Linux: the app icon in small, readable on light and dark taskbars.
const color = (alert: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <rect width="16" height="16" rx="3.5" fill="#1F5FAD"/>
  <rect x="5" y="2.75" width="6" height="1.5" rx=".75" fill="#7FA6D6"/>
  <rect x="3.75" y="5" width="8.5" height="1.75" rx=".75" fill="#BCD0EA"/>
  <rect x="2.5" y="7.5" width="11" height="6" rx="1.25" fill="#FFFFFF"/>
  ${alert ? `<circle cx="12.75" cy="3.25" r="3" fill="#E5484D" stroke="#FFFFFF" stroke-width="1"/>` : ""}
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
// Not a top-level await: Electron holds "ready" until the entry module finishes evaluating.
void app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL("data:text/html,<!doctype html><title>icons</title>");
  for (const [file, svg, size] of out) {
    const url: string = await w.webContents.executeJavaScript(`(${render})(${JSON.stringify(svg)}, ${size})`);
    fs.writeFileSync(path.join(dir, file), Buffer.from(url.split(",")[1], "base64"));
    console.log(`assets/${file} (${size}px)`);
  }
  app.quit();
});
