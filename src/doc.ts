// A review document (docs/review-format.md): one AI review, self-contained, that any client can render and any agent can
// write: the PR's meta, its files' hunks, and the review in the shape Claude answers in (src/review.ts's SCHEMA), each
// comment quoting the code it's on. readDoc() reads one through the parsers the desk reads Claude's answer with, so a
// document gets the same checks and caps; what it keeps is a fixed point: reading it again changes nothing.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { fsError, type FsError } from "./errors.ts";
import { lineAt, readAnswer } from "./review.ts";
import type { AiReview, DiagramGraph, ReviewFile, ReviewNote } from "./types.ts";

export const FORMAT = "inbox.review/1";

const MAX_FILES = 300;
const MAX_PATCH = 200_000; // characters, one file's
const MAX_PATCHES = 1_000_000; // all of them
export const MAX_DOC = 4 * 1024 * 1024; // bytes of JSON, as submitted
const STATUSES = ["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"] as const;
const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const DIAGRAM_ID = /^[A-Za-z][\w-]{0,15}$/;
const DOC_ID = /^[0-9a-f]{16}$/;

type Side = "new" | "old";
interface Quoted {
  path: string;
  side: Side;
  line: number;
  quote: string;
}

// The review as written: Claude's answer, less nothing a renderer needs.
interface DocReview {
  risk: AiReview["risk"];
  risk_reasons: { factor: string; why: string }[];
  intent: { goal: string; fit: string; gap: string; stack: string };
  verdict: AiReview["verdict"];
  summary: string;
  since: string;
  concerns: (Quoted & { body: string })[];
  look: (Quoted & { end: number; why: string })[];
  interfaces: (Quoted & { name: string; kind: string; change: string; breaking: boolean; impact: string })[];
  improvements: (Quoted & { body: string })[];
  notes: (Quoted & { body: string })[];
  chunks: { id: string; level: "look" | "skim"; why: string }[];
  steps: { title: string; body: string; check: string; note: string; diagram: string; hunks: string[] }[];
  diagrams: { id: string; title: string; caption: string; source: string; graph: DiagramGraph }[];
}

export interface ReviewDoc {
  format: typeof FORMAT;
  pr: { title: string; repo: string; number: number | null; url: string; author: string; head: string };
  by: string; // who wrote the review: the desk's "Inbox, <model>", or the agent's own words
  at: string;
  files: ReviewFile[];
  review: DocReview;
}

// What a renderer draws from: the review as the desk keeps it, read from the document.
export type Kept = Omit<AiReview, "head_oid" | "model" | "at">;

export type Read = { ok: true; doc: ReviewDoc; ai: Kept; dropped: string[] } | { ok: false; why: string };

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// oxlint-disable-next-line no-control-regex -- a path or a name with a control character in it is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------- reading

export function readDoc(raw: unknown): Read {
  const d = obj(raw);
  if (!d) return { ok: false, why: "a review document is a JSON object" };
  if (d.format !== FORMAT)
    return { ok: false, why: `format must be "${FORMAT}"${typeof d.format === "string" ? `, not "${d.format.slice(0, 40)}"` : ""}` };
  const pr = readPr(d.pr);
  if (typeof pr === "string") return { ok: false, why: pr };
  const files = readFiles(d.files);
  if (typeof files === "string") return { ok: false, why: files };
  const r = obj(d.review);
  if (!r) return { ok: false, why: "review must be an object: the review, in the shape docs/review-format.md gives" };
  const diagrams = Array.isArray(r.diagrams) ? r.diagrams : [];
  for (const g of diagrams) {
    const id = str(obj(g)?.id, 40);
    if (!DIAGRAM_ID.test(id)) return { ok: false, why: `a diagram's id is a letter, then up to 15 letters, digits, _ or -: "${id}"` };
    if (typeof obj(g)?.source !== "string") return { ok: false, why: `diagram ${id} has no source` };
  }
  const { review: ai, refused, unbacked } = readAnswer(r, files);
  if (refused.length) return { ok: false, why: `diagram ${refused[0]!}` };
  if (!ai.summary) return { ok: false, why: "the review has no summary" };
  const at = typeof d.at === "string" && !Number.isNaN(Date.parse(d.at)) ? new Date(d.at).toISOString() : new Date().toISOString();
  const doc: ReviewDoc = { format: FORMAT, pr, by: str(d.by, 80) || "an agent", at, files, review: answerOf(ai, files) };
  return { ok: true, doc, ai, dropped: droppedOf(r, ai, unbacked) };
}

function readPr(v: unknown): ReviewDoc["pr"] | string {
  const p = obj(v);
  if (!p) return "pr must be an object with at least a title";
  const title = str(p.title, 300);
  if (!title) return "pr.title is missing";
  const repo = str(p.repo, 140);
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return `pr.repo is owner/name: "${repo}"`;
  const number = p.number ?? null;
  if (number !== null && !(Number.isInteger(number) && (number as number) > 0)) return "pr.number is a positive whole number";
  const url = str(p.url, 500);
  if (url && !/^https:\/\/[^\s"<>]+$/.test(url)) return `pr.url is an https link: "${url.slice(0, 80)}"`;
  const author = str(p.author, 60);
  if (author && !/^[\w.[\]-]+$/.test(author)) return `pr.author is a login: "${author}"`;
  const head = str(p.head, 40);
  if (head && !/^[0-9a-f]{1,40}$/.test(head)) return "pr.head is a commit's sha";
  return { title, repo, number: number as number | null, url, author, head };
}

function readFiles(v: unknown): ReviewFile[] | string {
  if (!Array.isArray(v) || !v.length) return "files must list the changed files, each with its patch";
  if (v.length > MAX_FILES) return `${v.length} files: at most ${MAX_FILES}`;
  const out: ReviewFile[] = [];
  let total = 0;
  for (const raw of v) {
    const f = obj(raw);
    const p = typeof f?.path === "string" ? f.path : "";
    if (!p || p.length > 500 || CONTROL.test(p)) return "each file has a path";
    if (out.some((x) => x.path === p)) return `${p} is listed twice`;
    const prev = typeof f?.previous_path === "string" && !CONTROL.test(f.previous_path) ? f.previous_path.slice(0, 500) : null;
    const patch = typeof f?.patch === "string" ? f.patch.replaceAll("\r\n", "\n").replace(/\n$/, "") : null;
    if (patch !== null) {
      if (patch.length > MAX_PATCH) return `${p}: its patch is over ${MAX_PATCH} characters`;
      if (!HUNK.test(patch)) return `${p}: a patch starts with its first hunk's @@ line`;
      total += patch.length;
      if (total > MAX_PATCHES) return `the patches are over ${MAX_PATCHES} characters in all`;
    }
    const lines = (patch ?? "").split("\n");
    const count = (k: string, sign: string) =>
      patch === null ? (Number.isInteger(f?.[k]) ? Math.max(0, f![k] as number) : 0) : lines.filter((l) => l.startsWith(sign)).length;
    out.push({
      path: p,
      previous_path: prev,
      status: STATUSES.find((s) => s === f?.status) ?? "modified",
      additions: count("additions", "+"),
      deletions: count("deletions", "-"),
      patch,
    });
  }
  return out;
}

// Each part's count as written and as kept, where they differ, and comments whose quote isn't code in the diff.
function droppedOf(r: Record<string, unknown>, ai: Kept, unbacked: number): string[] {
  const n = (k: string) => (Array.isArray(r[k]) ? r[k].length : 0);
  const kept: [string, number][] = [
    ["concerns", ai.concerns.length],
    ["notes", ai.notes.length - ai.concerns.length],
    ["look", ai.look?.length ?? 0],
    ["interfaces", ai.interfaces?.length ?? 0],
    ["improvements", ai.improvements?.length ?? 0],
    ["steps", ai.guide?.steps.length ?? 0],
    ["diagrams", ai.diagrams?.length ?? 0],
  ];
  const out = kept.filter(([k, got]) => got < n(k)).map(([k, got]) => `${k}: ${got} of ${n(k)} kept`);
  if (unbacked) out.unshift(`${unbacked} ${unbacked === 1 ? "comment" : "comments"} quoting code that isn't in the diff`);
  if (n("steps") && !ai.guide) out.push("the walk-through: its steps cover too little of what's ranked, or fewer than two hold");
  return out;
}

// ---------------------------------------------------------------------------- writing

// The review as kept, back in the shape it's written in: each comment quoting its line (or, on a line with no words, a
// line of its file's diff that has some, which is all the check asks).
function answerOf(ai: Kept, files: ReviewFile[]): DocReview {
  const quote = (n: Pick<ReviewNote, "path" | "side" | "line">) => {
    const q = lineAt(files, n);
    return /[\p{L}\p{N}]/u.test(q) ? q : lineAt(files, { ...n, line: 0 });
  };
  const at = (n: Pick<ReviewNote, "path" | "side" | "line">) => ({ path: n.path, side: n.side, line: n.line, quote: quote(n) });
  const c = ai.concerns.length;
  const placed = ai.notes.slice(0, c).every((n, i) => n.body === ai.concerns[i]) ? c : 0;
  return {
    risk: ai.risk,
    risk_reasons: ai.risk_reasons ?? [],
    intent: ai.intent ?? { goal: "", fit: "undescribed", gap: "", stack: "" },
    verdict: ai.verdict,
    summary: ai.summary,
    since: ai.since ?? "",
    concerns: ai.notes.slice(0, placed).map((n) => Object.assign(at(n), { body: n.body })),
    look: (ai.look ?? []).map((l) => Object.assign(at(l), { end: l.end, why: l.why })),
    interfaces: (ai.interfaces ?? []).map((x) =>
      Object.assign(at(x), { name: x.name, kind: x.kind, change: x.change, breaking: x.breaking, impact: x.impact }),
    ),
    improvements: (ai.improvements ?? []).map((n) => Object.assign(at(n), { body: n.body })),
    notes: ai.notes.slice(placed).map((n) => Object.assign(at(n), { body: n.body })),
    chunks: (ai.chunks?.ranked ?? []).map((x) => ({ id: x.id, level: x.level, why: x.why })),
    steps: (ai.guide?.steps ?? []).map((s) => ({
      title: s.title,
      body: s.body,
      check: s.check,
      note: s.note ?? "",
      diagram: s.diagram ?? "",
      hunks: s.hunks.map((h) => h.id),
    })),
    diagrams: (ai.diagrams ?? []).flatMap((g) =>
      g.source === undefined ? [] : [{ id: g.id, title: g.title, caption: g.caption, source: g.source, graph: g.graph }],
    ),
  };
}

// The desk's own AI review of a PR as a document, read back through readDoc so it's what an agent's would be.
export function docOf(pr: ReviewDoc["pr"], files: ReviewFile[], ai: AiReview): Read {
  return readDoc({ format: FORMAT, pr, by: `Inbox, ${ai.model}`, at: ai.at, files, review: answerOf(ai, files) });
}

// Its id: the start of its canonical JSON's sha256, so the same document is one file however often it's sent.
export const docId = (doc: ReviewDoc) => createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 16);
const isDocId = (s: string) => DOC_ID.test(s);

// ---------------------------------------------------------------------------- storage

// <home>/docs/<id>.json and <id>.html: plain files any tool or agent can read, written once (an id is its content).
export const docsDir = (home: string) => path.join(home, "docs");

export function saveDoc(home: string, doc: ReviewDoc, page: string): Effect.Effect<{ id: string; json: string; html: string }, FsError> {
  const id = docId(doc);
  const dir = docsDir(home);
  const json = path.join(dir, `${id}.json`);
  const html = path.join(dir, `${id}.html`);
  return Effect.try({
    try: () => {
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, text] of [
        [json, `${JSON.stringify(doc, null, 2)}\n`],
        [html, page],
      ] as const) {
        fs.writeFileSync(`${file}.tmp`, text);
        fs.renameSync(`${file}.tmp`, file);
      }
      return { id, json, html };
    },
    catch: fsError("write", dir),
  });
}

export function loadDoc(home: string, id: string, ext: "json" | "html"): Effect.Effect<string | null, FsError> {
  const file = path.join(docsDir(home), `${id}.${ext}`);
  return Effect.try({
    try: () => (isDocId(id) && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null),
    catch: fsError("read", file),
  });
}
