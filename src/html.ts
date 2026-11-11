// Markup as plain data: a diagram's SVG (src/diagram-layout.ts) and a rendered review (src/render.ts) are built as these,
// so the window draws the same tree as React elements and Node writes it out as HTML. Text is always text: every string
// is escaped, and only `raw` (the page's own CSS) goes out as written.

type Attr = string | number | boolean | undefined;
export interface El {
  tag: string;
  attrs: Record<string, Attr>;
  kids: Kid[];
}
// Ours alone, never a document's words: the page's CSS and doctype.
interface Raw {
  raw: string;
}
export type Kid = El | Raw | string | number | null | undefined | false | Kid[];

export const el = (tag: string, attrs: Record<string, Attr> = {}, ...kids: Kid[]): El => ({ tag, attrs, kids });
export const raw = (text: string): Raw => ({ raw: text });

const VOID = new Set(["br", "meta", "wbr"]);
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function html(k: Kid): string {
  if (k === null || k === undefined || k === false) return "";
  if (typeof k === "string") return esc(k);
  if (typeof k === "number") return String(k);
  if (Array.isArray(k)) return k.map(html).join("");
  if ("raw" in k) return k.raw;
  let attrs = "";
  for (const [name, v] of Object.entries(k.attrs)) {
    if (v === undefined || v === false) continue;
    attrs += v === true ? ` ${name}` : ` ${name}="${esc(String(v)).replaceAll('"', "&quot;")}"`;
  }
  return VOID.has(k.tag) ? `<${k.tag}${attrs}>` : `<${k.tag}${attrs}>${k.kids.map(html).join("")}</${k.tag}>`;
}
