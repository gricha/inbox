// Excalidraw draws each stroke from an element's seed and picks a random one when none is given, so a diagram drawn again
// would wobble differently. A seed from the element's own content draws it the same each time.
export function seeded<T extends Record<string, unknown>>(elements: T[]): (T & { seed: number })[] {
  return elements.map((e) => ({ ...e, seed: hash(JSON.stringify(e)) }));
}

// FNV-1a, kept positive and non-zero as Excalidraw's own seeds are.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 0x01000193);
  return h >>> 1 || 1;
}
