// A note's icon is a name from an icon pack, never a picture: a Lucide icon ("receipt") or a Simple Icons brand
// ("brand:gmail"). The window draws it from the pack, so what a run read can't put an image on the desk.
import fs from "node:fs";
import { createRequire } from "node:module";
import { Effect, Schema } from "effect";
import { NotFound } from "./errors.ts";
import { decodeEach, field, isRecord } from "./narrow.ts";
import { BRAND, type BrandIcon } from "./types.ts";

const require = createRequire(import.meta.url);

// How an icon is named, for a run and for an agent setting one: a name off both packs is dropped or refused.
export const ICON_FORMAT = `A Lucide icon's name (lucide.dev/icons: "receipt" for a bill, "plane" for a flight, "calendar", "package", "shield-alert", "message-circle") or ${BRAND}<a Simple Icons slug> for a brand's logo (simpleicons.org: "${BRAND}gmail", "${BRAND}github", "${BRAND}slack")`;

// Both lists are read on first use (Simple Icons' is half a megabyte), and through require so lucide-react's React types
// stay out of the desk's.
let lucide: Set<string> | undefined;
function lucideNames(): Set<string> {
  if (lucide) return lucide;
  const all = field(require("lucide-react/dynamicIconImports"), "default");
  lucide = new Set(isRecord(all) ? Object.keys(all) : []);
  return lucide;
}
const BrandSchema = Schema.Struct({ slug: Schema.String, title: Schema.String, hex: Schema.String });
let brands: Map<string, { title: string; hex: string }> | undefined;
const brandList = () => (brands ??= new Map(decodeEach(BrandSchema, require("simple-icons/icons.json")).map((b) => [b.slug, b])));

// The name as given when either pack has it, else none.
export function iconName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.startsWith(BRAND)) return brandList().has(raw.slice(BRAND.length)) ? raw : undefined;
  return lucideNames().has(raw) ? raw : undefined;
}

// GET /api/icons/brand/:slug: a brand's logo (24×24) and its colour, for the window to draw.
export function brandIcon(slug: string): Effect.Effect<BrandIcon, NotFound> {
  return Effect.gen(function* () {
    const b = brandList().get(slug);
    if (!b) return yield* new NotFound({ message: `Simple Icons has no "${slug}"` });
    const svg = fs.readFileSync(require.resolve(`simple-icons/icons/${slug}.svg`), "utf8");
    const path = /<path d="([^"]+)"/.exec(svg)?.[1];
    if (!path) return yield* new NotFound({ message: `Simple Icons' "${slug}" has no path` });
    return { title: b.title, hex: b.hex, path };
  });
}
