// A note's icon from its pack, loaded with this file only when a note has one: a Lucide icon by its name, each its own
// chunk, or a Simple Icons logo the desk serves by slug.
import { Effect } from "effect";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import { useEffect, useState } from "react";
import { BRAND, type BrandIcon } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";

const brands = new Map<string, BrandIcon>();

function Brand({ slug, fallback }: { slug: string; fallback: React.JSX.Element }) {
  const [b, setB] = useState(() => brands.get(slug));
  useEffect(() => {
    const known = brands.get(slug);
    setB(known);
    const stop = new AbortController();
    if (!known)
      runUi(
        api.brandIcon(slug).pipe(
          Effect.match({
            onSuccess: (got) => {
              brands.set(slug, got);
              setB(got);
            },
            // A slug the desk's pack no longer has keeps a note's icon.
            onFailure: () => {},
          }),
        ),
        { signal: stop.signal },
      );
    return () => {
      stop.abort();
    };
  }, [slug]);
  if (!b) return fallback;
  // Its own colour, kept readable: no lighter than a mid tone on a light theme, no darker on a dark one.
  const color = `light-dark(oklch(from #${b.hex} min(l, 0.62) c h), oklch(from #${b.hex} max(l, 0.75) c h))`;
  return (
    <svg className="i brand" viewBox="0 0 24 24" style={{ color }} aria-hidden="true" focusable="false">
      <path d={b.path} />
    </svg>
  );
}

export default function PackIcon({ name, fallback }: { name: string; fallback: React.JSX.Element }) {
  if (name.startsWith(BRAND)) return <Brand slug={name.slice(BRAND.length)} fallback={fallback} />;
  const lucide = iconNames.find((n) => n === name);
  return lucide ? <DynamicIcon name={lucide} className="i" size={16} aria-hidden="true" fallback={() => fallback} /> : fallback;
}
