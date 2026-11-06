// What a PR needs merged before it, and who blocks whom: from its description and its git stack. Pure.

// Descriptions are attacker-written: no pattern here has nested or overlapping unbounded quantifiers, so each runs in linear time.
const REF = String.raw`(?:https://github\.com/[\w.-]+/[\w.-]+/(?:pull|issues)/\d+(?:[^\d\s)\],;][^\s)\],;]*)?|[\w.-]+/[\w.-]+#\d+|(?<![\w/])#\d+)`;
const REFS = String.raw`${REF}(?:(?:\s*(?:,|&|\+|\band\b)\s*|\s+)${REF})*`;
const FILLER = String.raw`(?:[^\s.,;:#\x60]+\s+){0,4}\(?`; // up to 4 words: "the cleanup PR (", "Seer reader"
// A few words may sit between these and the ref ("Stacked on the cleanup PR (#8943)"); none after the rest.
const NAMED = String.raw`depends on|dependent on|blocked (?:by|on)|stacked on(?: top of)?|builds on(?: top of)?`;
const DIRECT = String.raw`requires|needs|(?:merge|land) (?:this |it )?after|lands after`;
const PATTERNS = [
  new RegExp(String.raw`\b(?:${NAMED}):?\s+${FILLER}(?<refs>${REFS})`, "gi"),
  new RegExp(String.raw`\b(?:${DIRECT}):?\s+(?<refs>${REFS})`, "gi"),
];
const REF_G = new RegExp(REF, "g");
const ENDS = new RegExp(String.raw`\b(?:${NAMED}|${DIRECT}):?\s*$`, "i"); // "merge blocked on:" with the refs on the lines below
const ITEM = new RegExp(String.raw`^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(${REF})\s*$`);
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/;
const WORD = /[A-Za-z0-9]/;

// An unclosed block runs to the end, as GitHub renders it, so a body of openers is read once.
function clean(md: string): string {
  const lines = md
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/<details\b[^<>]*>[\s\S]*?(?:<\/details>|$)/gi, " ")
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replaceAll(/```[\s\S]*?(?:```|$)/g, " ")
    .replaceAll(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .map((l) => l.replaceAll(/\[([^[\]\n]*)\]\(([^()\s]*)\)/g, (_, text: string, url: string) => (PR_URL.test(url) ? url : text)));
  for (const [i, line] of lines.entries()) {
    if (!ENDS.test(line.replaceAll(/[*_]/g, ""))) continue;
    const refs: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (j === i + 1 && !l.trim()) continue; // "Blocked on:", a blank line, then the list
      const m = ITEM.exec(l);
      if (!m) break;
      if (m[1] === undefined || m[1] === " ") refs.push(m[2]!);
    }
    if (refs.length) lines[i] = `${line} ${refs.join(", ")}`;
  }
  // Emphasis: "**Merge after** x#1" reads "Merge after x#1"; sentry_plugins#12 keeps its underscore.
  return lines
    .join("\n")
    .replaceAll("*", "")
    .replaceAll(/_+/g, (run: string, at: number, s: string) =>
      WORD.test(s[at - 1] ?? "") && WORD.test(s[at + run.length] ?? "") ? run : "",
    );
}

const normal = (ref: string, repo: string): string => {
  const url = PR_URL.exec(ref);
  if (url) return `${url[1]}#${url[2]}`;
  return ref.startsWith("#") ? `${repo}${ref}` : ref;
};

export function requiresOf(md: string, repo: string, number: number): string[] {
  const self = `${repo}#${number}`.toLowerCase();
  const out = new Map<string, string>();
  for (const sentence of clean(md).split(/\n|(?<=[.;!?])\s/))
    for (const p of PATTERNS)
      for (const m of sentence.matchAll(p))
        for (const [ref] of m.groups!.refs!.matchAll(REF_G)) {
          const x = normal(ref, repo);
          const k = x.toLowerCase();
          if (k !== self && !out.has(k)) out.set(k, x);
        }
  return [...out.values()].slice(0, 10);
}
