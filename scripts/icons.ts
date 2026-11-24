// npm run icons: writes every icon from the paths in assets/brand/mark.svg, the PNGs rendered in an offscreen Electron window.
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const dir = path.join(root, "assets");
const paths = [...fs.readFileSync(path.join(dir, "brand", "mark.svg"), "utf8").matchAll(/<path d="([^"]+)"/g)];
if (!paths.length) throw new Error("assets/brand/mark.svg has no <path d>");
const mark = paths.map((m) => `<path d="${m[1]}"/>`).join("");
// Triage: the rows are Urgent, Standard and FYI in the window's Dark red, amber and pencil, on its violet ink.
const ROWS = ["#FFB4AB", "#EBC076", "#ACA4BD"];
if (paths.length !== ROWS.length) throw new Error(`assets/brand/mark.svg has ${paths.length} rows, not ${ROWS.length}`);
const rows = paths.map((m, i) => `<path d="${m[1]}" fill="${ROWS[i]}"/>`).join("");

const INK = "#1D1733";
const MARK_WHITE = "#F6F3FC";
const svg = (viewBox: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

// The alert's dot sits in the corner the rows leave clear (bottom right, past the shortest bar), never on the mark.
const tile = (alert: boolean) =>
  svg(
    "0 0 64 64",
    `<rect width="64" height="64" rx="13.5" fill="${INK}"/>${rows}` + (alert ? `<circle cx="54" cy="54" r="10" fill="#E5484D"/>` : ""),
  );

// The app icon on the macOS grid (an 824 tile at 100,100, its corner), the kit's tile scaled to it: flat, no highlight.
const icon = svg(
  "0 0 1024 1024",
  `<rect x="100" y="100" width="824" height="824" rx="185" fill="${INK}"/><g transform="translate(100 100) scale(12.875)">${rows}</g>`,
);

// A build that isn't the release says so in the Dock and menu bar (appVariant in electron/lib.ts): its own colour, and on
// the app icon its name under the mark.
const VARIANTS = { dev: { fill: "#C2410C", label: "DEV" }, qa: { fill: "#2F5BD3", label: "QA" } } as const;
const variantIcon = (fill: string, label: string) =>
  svg(
    "0 0 1024 1024",
    `<rect x="100" y="100" width="824" height="824" rx="185" fill="${fill}"/><g fill="${MARK_WHITE}" transform="translate(152 90) scale(11.25)">${mark}</g>` +
      `<text x="512" y="842" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-weight="800" font-size="168" letter-spacing="14" fill="${MARK_WHITE}">${label}</text>`,
  );
const variantTile = (fill: string, alert: boolean) =>
  svg(
    "0 0 64 64",
    `<rect width="64" height="64" rx="13.5" fill="${fill}"/><g fill="${MARK_WHITE}">${mark}</g>` +
      (alert ? `<circle cx="54" cy="54" r="10" fill="#E5484D"/>` : ""),
  );

// Maskable: full bleed, the mark at three quarters so it stays inside the platform's safe zone.
const maskable = svg("0 0 64 64", `<rect width="64" height="64" fill="${INK}"/><g transform="translate(8 8) scale(.75)">${rows}</g>`);

// The menu bar's template image (alpha only): the silhouette (x 12.2–51.6, y 13.2–50.8) and a margin, 22×16 pt like its
// neighbours.
const template = svg("3.3 11.2 57.2 41.6", `<g fill="#000">${mark}</g>`);

const dot = svg("0 0 16 16", `<circle cx="8" cy="8" r="7" fill="#E5484D" stroke="#FFFFFF" stroke-width="1.5"/>`);

const vectors: [file: string, svg: string][] = [
  ["assets/brand/tile.svg", tile(false)],
  ["assets/icon.svg", icon],
  ["web/public/icon.svg", tile(false)],
  ["web/public/icon-maskable.svg", maskable],
];
const rasters: [file: string, svg: string, width: number, height: number][] = [
  ["icon.png", icon, 1024, 1024],
  ["trayTemplate.png", template, 22, 16],
  ["trayTemplate@2x.png", template, 44, 32],
  ["tray.png", tile(false), 16, 16],
  ["tray@2x.png", tile(false), 32, 32],
  ["tray-alert.png", tile(true), 16, 16],
  ["tray-alert@2x.png", tile(true), 32, 32],
  ["overlay-alert.png", dot, 16, 16],
  ["../ios/Inbox/Assets.xcassets/AppIcon.appiconset/icon-1024.png", maskable, 1024, 1024],
  ...Object.entries(VARIANTS).flatMap(([name, v]): [string, string, number, number][] => [
    [`icon-${name}.png`, variantIcon(v.fill, v.label), 1024, 1024],
    [`tray-${name}.png`, variantTile(v.fill, false), 16, 16],
    [`tray-${name}@2x.png`, variantTile(v.fill, false), 32, 32],
    [`tray-${name}-alert.png`, variantTile(v.fill, true), 16, 16],
    [`tray-${name}-alert@2x.png`, variantTile(v.fill, true), 32, 32],
  ]),
];

// Sized <svg> so Chromium rasterizes the vector at the target size instead of scaling a 300x150 bitmap.
const render = `async (svg, w, h) => {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.replace("<svg ", '<svg width="' + w + '" height="' + h + '" '));
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
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
  for (const [file, text] of vectors) {
    fs.writeFileSync(path.join(root, file), `${text}\n`);
    console.log(file);
  }
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL("data:text/html,<!doctype html><title>icons</title>");
  for (const [file, text, width, height] of rasters) {
    const url: unknown = await w.webContents.executeJavaScript(`(${render})(${JSON.stringify(text)}, ${width}, ${height})`);
    const png = typeof url === "string" ? url.split(",")[1] : undefined;
    if (png === undefined) throw new Error(`rendering ${file} returned ${String(url)}`);
    fs.writeFileSync(path.join(dir, file), Buffer.from(png, "base64"));
    console.log(`assets/${file} (${width}×${height}px)`);
  }
  app.quit();
}
