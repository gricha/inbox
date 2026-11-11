// Markup as plain data: a diagram's SVG (src/diagram-layout.ts) is built as these, so the window draws the tree as React
// elements and anything else can write the same tree out.

type Attr = string | number | boolean | undefined;
export interface El {
  tag: string;
  attrs: Record<string, Attr>;
  kids: Kid[];
}
// Ours alone, never a document's words.
interface Raw {
  raw: string;
}
export type Kid = El | Raw | string | number | null | undefined | false | Kid[];

export const el = (tag: string, attrs: Record<string, Attr> = {}, ...kids: Kid[]): El => ({ tag, attrs, kids });
