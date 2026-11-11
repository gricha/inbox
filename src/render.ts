// A review document (src/doc.ts) as one self-contained HTML page: the window's review in its words, its order and its
// look (the review's rules and the Light and Dark tokens, taken from web/src/styles.css, then web/src/doc.css), its
// diagrams laid out here by ELK as static SVG, its fonts inline. No script, no request: a strict CSP says so too. Every
// word in it is the document's, so it's only ever text.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Effect } from "effect";
import type { ELK } from "elkjs/lib/elk-api.js";
import { diagramText } from "./diagram.ts";
import { fontMeasure, layout, svg } from "./diagram-layout.ts";
import { MAX_DOC, readDoc, type Kept, type ReviewDoc } from "./doc.ts";
import { BadRequest, fsError, type FsError } from "./errors.ts";
import { el, html, raw, type Kid } from "./html.ts";
import { blocks, inline, lead, unlinked, type Block, type Span } from "./prose.ts";
import { reviewOrder } from "./review.ts";
import { FIT, LEVEL, onLines, sections, STATUS, VERDICT, walk, type Section } from "./sections.ts";
import type { ReviewDiagram, ReviewFile, ReviewHunk } from "./types.ts";

// CommonJS, whose default export TypeScript reads one way under Node's resolution and another under Vite's.
const Elk = createRequire(import.meta.url)("elkjs/lib/elk.bundled.js") as new () => ELK;
const WEB = path.join(import.meta.dirname, "..", "web", "src");
const FONTS: Record<string, string> = {
  "instrument-sans-latin-standard-normal.woff2": "",
  "jetbrains-mono-latin-wght-normal.woff2": "",
};
// The classes and elements this page draws: the window's rules for them are its look.
const USED = new Set(
  `body a code p :focus-visible .quiet .ref .ref-ink .ref-repo .verdict .v-look .v-skip .risk .r-high .r-medium .r-low .meter
  .prose .rv-head .rv-ref .rv-by .rv-title .rv-meta .rv-ai .rv-verdict .rv-reason .rv-gist .rv-since .rv-more-line .rv-more-head
  .rv-more-list .rv-more-item .rv-concerns .rv-diffs .rv-step .rv-step-head .rv-step-n .rv-step-body .rv-step-note .rv-next
  .rv-file-sec .rv-fhead .rv-fold-btn .rv-level .l-skim .l-unread .l-skip .rv-fname .rv-dir .rv-base .rv-why .rv-fstatus
  .rv-delta .fold .rv-fold .rv-note .rv-look .dg .dg-head .dg-title .dg-svg .dg-node .dg-new .dg-changed .dg-removed .dg-line
  .dg-dotted .dg-tip .dg-label .dg-label-bg .dg-group .dg-life .dg-note .dg-text`.split(/\s+/),
);

// What the page may load: its own styles and inline fonts, nothing else, and no script at all.
export const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:";

let css: string | null = null;

// The window's rules for what this page draws, in their order, with Light's and Dark's tokens and the fonts inline.
function pageCss(): Effect.Effect<string, FsError> {
  if (css !== null) return Effect.succeed(css);
  const file = path.join(WEB, "styles.css");
  return Effect.try({
    try: () => {
      for (const name of Object.keys(FONTS)) FONTS[name] = fs.readFileSync(path.join(WEB, "fonts", name)).toString("base64");
      const own = fs.readFileSync(path.join(WEB, "doc.css"), "utf8");
      css = `${pick(fs.readFileSync(file, "utf8"))}\n${own}`;
      return css;
    },
    catch: fsError("read", file),
  });
}

// styles.css's top-level blocks: a rule is kept when one of its selectors starts with a class or element this page uses.
function pick(text: string): string {
  const src = text.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let at = 0;
  while (at < src.length) {
    const open = src.indexOf("{", at);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    while (depth && end < src.length) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}") depth--;
      end++;
    }
    const head = src.slice(at, open).trim();
    const body = src.slice(open, end);
    at = end;
    if (head === "@font-face") {
      const name = /fonts\/([\w.-]+)/.exec(body)?.[1] ?? "";
      if (FONTS[name]) out.push(`@font-face ${body.replace(/url\([^)]*\)/, `url(data:font/woff2;base64,${FONTS[name]})`)}`);
    } else if (head === ":root") out.push(`${head} ${body}`);
    else if (head === "@media (prefers-color-scheme: dark)" && body.includes(":root:not([data-theme]) {")) {
      const tokens = /:root:not\(\[data-theme\]\) \{[^}]*\}/.exec(body)?.[0];
      if (tokens) out.push(`@media (prefers-color-scheme: dark) { ${tokens} }`);
    } else if (!head.startsWith("@") && head.split(",").some((s) => USED.has(/^(?:[a-z]+|\.[\w-]+|:[\w-]+)/.exec(s.trim())?.[0] ?? "")))
      out.push(`${head} ${body}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------- the page

// A document as written (JSON), read and rendered: what `desk render`, desk_doc and POST /api/docs share. What it refuses
// says why, in the words an agent can fix it from.
export function renderText(text: string): Effect.Effect<{ doc: ReviewDoc; html: string; dropped: string[] }, BadRequest | FsError> {
  return Effect.gen(function* () {
    if (Buffer.byteLength(text) > MAX_DOC) return yield* new BadRequest({ message: `not a review document: over ${MAX_DOC} bytes` });
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (e) => new BadRequest({ message: `not a review document: ${e instanceof Error ? e.message : "not JSON"}` }),
    });
    const r = readDoc(parsed);
    if (!r.ok) return yield* new BadRequest({ message: `not a review document: ${r.why}` });
    return { doc: r.doc, html: yield* renderDoc(r.doc, r.ai), dropped: r.dropped };
  });
}

export function renderDoc(doc: ReviewDoc, ai: Kept): Effect.Effect<string, FsError> {
  return Effect.gen(function* () {
    const style = yield* pageCss();
    const figures = yield* drawDiagrams(ai.diagrams ?? []);
    const order = reviewOrder(doc.files, { ...ai, head_oid: "", model: "", at: "" }, false);
    const guided = !!order.steps?.length;
    const view = guided ? walk(order) : { ...sections(order), steps: [], beyond: 0 };
    const figure = (id: string) => figures.get(id) ?? null;
    const { pr } = doc;
    const adds = doc.files.reduce((n, f) => n + f.additions, 0);
    const dels = doc.files.reduce((n, f) => n + f.deletions, 0);
    const page = el(
      "html",
      { lang: "en" },
      el(
        "head",
        {},
        el("meta", { charset: "utf-8" }),
        el("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
        el("meta", { name: "color-scheme", content: "light dark" }),
        el("meta", {
          "http-equiv": "Content-Security-Policy",
          content: DOC_CSP,
        }),
        el("meta", { name: "generator", content: doc.format }),
        el("title", {}, `${pr.title} · AI review`),
        el("style", {}, raw(style)),
      ),
      el(
        "body",
        {},
        el(
          "main",
          { class: "doc" },
          el(
            "header",
            { class: "rv-head" },
            (pr.repo || pr.author) &&
              el(
                "p",
                { class: "rv-ref" },
                pr.repo &&
                  el(
                    pr.url ? "a" : "span",
                    {
                      class: "ref",
                      href: pr.url || undefined,
                      target: pr.url ? "_blank" : undefined,
                      rel: pr.url ? "noreferrer" : undefined,
                    },
                    el(
                      "span",
                      { class: "ref-ink" },
                      el("span", { class: "ref-repo" }, pr.repo.split("/")[1]),
                      pr.number ? `#${pr.number}` : "",
                    ),
                  ),
                pr.author && el("span", { class: "rv-by" }, `by ${pr.author}`),
              ),
            el("h1", { class: "rv-title" }, pr.title),
            el(
              "p",
              { class: "rv-meta" },
              el("span", {}, `AI review by ${doc.by}, ${doc.at.slice(0, 10)}`),
              el("span", {}, `${doc.files.length} ${doc.files.length === 1 ? "file" : "files"}, +${adds} −${dels}`),
            ),
          ),
          aiSection(ai, order.notes.length, figure),
          el("div", { class: "rv-diffs" }, diffs(doc.files, ai, view, figure, order.ranked)),
          el("footer", { class: "doc-foot quiet" }, `${doc.format} · rendered by Inbox`),
        ),
      ),
    );
    return `<!doctype html>\n${html(page)}\n`;
  });
}

const words = (text: string): Kid => spans(unlinked(inline(text)));

function spans(ss: Span[]): Kid {
  return ss.map((s) => {
    const k = s.t === "code" ? el("code", {}, s.text) : s.t === "text" ? s.text : s.url;
    return s.bold ? el("b", {}, k) : k;
  });
}

function prose(bs: Block[]): Kid {
  return el(
    "div",
    { class: "prose" },
    bs.map((b) => {
      if (b.t === "pre") return el("pre", {}, el("code", {}, b.text));
      if (b.t === "p") return el("p", {}, spans(unlinked(b.spans)));
      const items = b.items.map((s) => el("li", {}, spans(unlinked(s))));
      return b.t === "ul" ? el("ul", {}, items) : el("ol", { start: b.start }, items);
    }),
  );
}

// A line of the diff's anchor, for a list's link to it.
const anchor = (file: string, side: "new" | "old", line: number) => `L-${side[0]}${line}-${encodeURIComponent(file)}`;

// The summary as the window's review has it, unfolded: a document is there to be read whole.
function aiSection(ai: Kept, notes: number, figure: (id: string) => Kid): Kid {
  const goal = ai.intent?.goal ?? "";
  const { first, rest } = goal ? { first: inline(goal), rest: blocks(ai.summary) } : lead(blocks(ai.summary));
  const reasons = ai.risk_reasons ?? [];
  const lead1 = ai.risk !== "low" ? reasons[0] : undefined;
  const later = lead1 ? reasons.slice(1) : reasons;
  const loose = ai.diagrams?.find((d) => !ai.guide?.steps.some((st) => st.diagram === d.id));
  const item = (x: { path: string; side: "new" | "old"; line: number }, kids: Kid) =>
    el("a", { class: "rv-more-item", href: `#${anchor(x.path, x.side, x.line)}`, title: `${x.path}:${x.line}` }, kids);
  return el(
    "section",
    { class: "rv-ai", "aria-label": "AI review" },
    el(
      "p",
      { class: "rv-verdict" },
      el("span", { class: `verdict v-${ai.verdict}` }, VERDICT[ai.verdict]),
      el(
        "span",
        { class: `risk r-${ai.risk}` },
        el("span", { class: "meter", "aria-hidden": "true" }, el("span"), el("span"), el("span")),
        `${ai.risk} risk`,
      ),
      lead1 && el("span", { class: "quiet rv-reason" }, lead1.why),
    ),
    first.length > 0 && el("p", { class: "rv-gist" }, spans(unlinked(first))),
    ai.intent?.stack && el("p", { class: "rv-since" }, el("b", {}, "In the stack:"), " ", words(ai.intent.stack)),
    ai.intent &&
      FIT[ai.intent.fit] &&
      ai.intent.gap &&
      el("p", { class: "rv-since" }, el("b", {}, `${FIT[ai.intent.fit]}:`), " ", words(ai.intent.gap)),
    rest.length > 0 && prose(rest),
    later.length > 0 && el("p", { class: "rv-more-line" }, el("b", {}, "Also risky:"), ` ${later.map((r) => r.why).join("; ")}`),
    (ai.interfaces?.length ?? 0) > 0 &&
      el(
        "div",
        { class: "rv-more-list" },
        el("h3", { class: "rv-more-head" }, "Interfaces"),
        el(
          "ul",
          {},
          ai.interfaces!.map((x) =>
            el(
              "li",
              {},
              item(x, [el("code", {}, x.name), ` ${x.change}`, x.breaking && el("b", {}, " breaking")]),
              " ",
              el("span", { class: "quiet" }, words(x.impact)),
            ),
          ),
        ),
      ),
    (ai.improvements?.length ?? 0) > 0 &&
      el(
        "div",
        { class: "rv-more-list" },
        el("h3", { class: "rv-more-head" }, "Could be better"),
        el(
          "ul",
          {},
          ai.improvements!.map((x) => el("li", {}, item(x, words(x.body)))),
        ),
      ),
    loose && figure(loose.id),
    ai.since && el("p", { class: "rv-since" }, el("b", {}, "Since your review:"), " ", words(ai.since)),
    // Each concern is also a note in the code; listed here only when the notes can't sit there.
    notes === 0 &&
      (ai.concerns.length > 0
        ? el(
            "ul",
            { class: "rv-concerns", "aria-label": "Concerns" },
            ai.concerns.map((c) => el("li", {}, words(c))),
          )
        : el("p", { class: "quiet" }, "No concerns.")),
  );
}

// The sections in the window's order: the walk-through's steps, what no step covers, then the desk's fold, closed.
function diffs(
  files: ReviewFile[],
  ai: Kept,
  view: {
    list: Section[];
    rest: number;
    steps: { at: number; title: string; body: string; check: string; note: string; diagram: string }[];
    beyond: number;
  },
  figure: (id: string) => Kid,
  ranked: boolean,
): Kid {
  const { list, rest, steps, beyond } = view;
  const outside = list.slice(beyond, rest);
  const outHunks = outside.reduce((n, y) => n + y.hunks.length, 0);
  const outFiles = new Set(outside.map((y) => y.path)).size;
  const shown = list.slice(0, rest).map((x, i) => {
    const k = steps.findIndex((st) => st.at === i);
    const end = steps.findIndex((_, j) => (steps[j + 1]?.at ?? beyond) === i + 1);
    const next = steps[end + 1];
    const st = steps[k];
    return [
      st &&
        el(
          "header",
          { class: "rv-step", id: `rv-step-${k}` },
          el("h2", { class: "rv-step-head" }, el("span", { class: "rv-step-n" }, `${k + 1} of ${steps.length}`), " ", st.title),
          st.body && el("p", { class: "rv-step-body" }, words(st.body)),
          st.check && el("p", { class: "rv-step-body" }, el("b", {}, "Check:"), " ", words(st.check)),
          st.note && el("p", { class: "rv-step-body rv-step-note" }, words(st.note)),
          st.diagram && figure(st.diagram),
        ),
      steps.length > 0 &&
        i === beyond &&
        el(
          "h2",
          { class: "rv-step rv-step-head", id: "rv-beyond" },
          `Not in the walk-through · ${outHunks} ${outHunks === 1 ? "hunk" : "hunks"} in ${outFiles} ${outFiles === 1 ? "file" : "files"}`,
        ),
      section(x, files[x.file]!, ai),
      end >= 0 &&
        (next
          ? el("a", { class: "rv-next", href: `#rv-step-${end + 1}` }, `Next: ${next.title}`)
          : el("p", { class: "quiet rv-next" }, "End of the walk-through")),
    ];
  });
  const folded = list.slice(rest);
  return [
    shown,
    ranked &&
      folded.length > 0 &&
      el(
        "details",
        { class: "doc-rest" },
        el("summary", { class: "fold rv-fold" }, `Not worth reviewing · ${folded.length} ${folded.length === 1 ? "file" : "files"}`),
        el(
          "div",
          { class: "rv-diffs" },
          folded.map((x) => section(x, files[x.file]!, ai)),
        ),
      ),
    !ranked && folded.map((x) => section(x, files[x.file]!, ai)),
  ];
}

function section(x: Section, file: ReviewFile, ai: Kept): Kid {
  const i = x.path.lastIndexOf("/");
  const [dir, name] = [x.path.slice(0, i + 1), x.path.slice(i + 1)];
  const status = STATUS[file.status];
  const adds = x.hunks.reduce((n, h) => n + h.additions, 0);
  const dels = x.hunks.reduce((n, h) => n + h.deletions, 0);
  const mine = x.notes.flatMap((n) => {
    const note = ai.notes[n];
    return note ? [{ note, inline: onLines(x.hunks, note) }] : [];
  });
  return el(
    "section",
    { class: "rv-file-sec", "aria-label": x.path },
    el(
      "h3",
      { class: "rv-fhead" },
      el(
        "span",
        { class: "rv-fold-btn" },
        x.level && el("span", { class: `rv-level l-${x.level}` }, LEVEL[x.level]),
        el(
          "span",
          { class: "rv-fname" },
          dir && el("span", { class: "rv-dir" }, el("bdi", {}, dir)),
          el("span", { class: "rv-base" }, name),
        ),
      ),
      x.why && el("span", { class: "rv-why", title: x.why }, x.why),
      status && el("span", { class: "rv-fstatus" }, `${status}${file.previous_path ? ` from ${file.previous_path}` : ""}`),
      x.hunks.length > 0 && el("span", { class: "rv-delta" }, `+${adds} −${dels}`),
    ),
    mine.filter((n) => !n.inline).map((n) => el("div", { class: "rv-note" }, words(n.note.body))),
    x.hunks.length > 0 &&
      table(
        x,
        ai,
        mine.filter((n) => n.inline).map((n) => n.note),
      ),
  );
}

// The hunks as the window's diff draws them, unified: each line's number (a removed one's in the old file), its sign's colour, and under a line what the
// review says of it: where to look, then its notes.
function table(x: Section, ai: Kept, notes: { path: string; side: "new" | "old"; line: number; body: string }[]): Kid {
  const looks = [...new Set(x.hunks.flatMap((h) => h.looks ?? []))].flatMap((i) => ai.look?.[i] ?? []);
  const under = (side: "new" | "old", line: number): Kid[] => [
    ...looks
      .filter((l) => l.side === side && l.line === line)
      .map((l) =>
        el(
          "div",
          { class: "rv-note rv-look" },
          el("b", {}, `Look here${l.end > l.line ? `, lines ${l.line}–${l.end}` : ""}:`),
          " ",
          words(l.why),
        ),
      ),
    ...notes.filter((n) => n.side === side && n.line === line).map((n) => el("div", { class: "rv-note" }, words(n.body))),
  ];
  return el(
    "table",
    { class: "doc-diff" },
    el("colgroup", {}, el("col", { class: "dd-num" }), el("col")),
    el(
      "tbody",
      {},
      x.hunks.map((h: ReviewHunk) => {
        let o = 0;
        let n = 0;
        return h.patch.split("\n").map((line) => {
          const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
          if (at) {
            o = Number(at[1]);
            n = Number(at[2]);
            return el("tr", { class: "dd-sep" }, el("td", { colspan: 2 }, (at[3] ?? "").padEnd(1, "\u00a0")));
          }
          const sign = line[0];
          if (sign !== "+" && sign !== "-" && sign !== " ") return null;
          const side = sign === "-" ? "old" : "new";
          const num = sign === "-" ? o : n;
          const row = el(
            "tr",
            { class: sign === "+" ? "dd-add" : sign === "-" ? "dd-del" : "dd-ctx", id: anchor(x.path, side, num) },
            el("td", { class: "dd-n" }, num),
            el("td", { class: "dd-code" }, line.slice(1) || "\u00a0"),
          );
          if (sign !== "+") o++;
          if (sign !== "-") n++;
          const said = under(side, num);
          return [row, said.length > 0 && el("tr", { class: "dd-said" }, el("td", { colspan: 2 }, said))];
        });
      }),
    ),
  );
}

// ---------------------------------------------------------------------------- diagrams

// Each laid out by ELK here, as the window's worker does, and drawn by the same code; one that won't lay out is its lines.
function drawDiagrams(list: ReviewDiagram[]): Effect.Effect<Map<string, Kid>> {
  const elk = new Elk();
  return Effect.forEach(list, (d, i) =>
    Effect.tryPromise(() => layout(d.graph, (root) => elk.layout(root), fontMeasure)).pipe(
      Effect.match({
        onFailure: () =>
          el(
            "ul",
            { class: "dg-text" },
            diagramText(d.graph).map((l) => el("li", {}, l)),
          ),
        onSuccess: (drawn) =>
          svg(drawn, {
            label: d.title ? d.title : "Diagram",
            desc: diagramText(d.graph).join("\n"),
            descId: `dg-${i}`,
            measure: fontMeasure,
          }),
      }),
      Effect.map((drawing): [string, Kid] => [
        d.id,
        el(
          "figure",
          { class: "dg" },
          (d.title || d.caption) &&
            el(
              "figcaption",
              { class: "dg-head" },
              d.title && el("span", { class: "dg-title" }, d.title),
              d.caption && el("span", { class: "dg-caption" }, d.caption),
            ),
          drawing,
        ),
      ]),
    ),
  ).pipe(Effect.map((pairs) => new Map(pairs)));
}
