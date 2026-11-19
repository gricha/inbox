// Your tags on a PR's hunks (config.toml's [[tags]], docs/api.md → Your tags). A tag's `when` is checked per hunk as the review
// is drawn; its `ask` goes into the AI review's own prompt, which answers it of each hunk it reads.
import { Result } from "effect";
import type { CompiledTag } from "./config.ts";
import { hunksOf } from "./review.ts";
import type { HunkTag, ReviewFile, Signals } from "./types.ts";

// The questions the AI review answers: each tag with an `ask`, in config.toml's order.
export const asksOf = (tags: readonly CompiledTag[]): { id: string; ask: string }[] =>
  tags.flatMap((t) => (t.config.ask ? [{ id: t.config.id, ask: t.config.ask }] : []));

// Each hunk's tags by mark, in config.toml's order: where its `when` passes (one its values can't evaluate is no) and, for a
// question, where the AI review said yes (`said`, by mark).
export function tagsOf(
  tags: readonly CompiledTag[],
  files: ReviewFile[],
  signals: Signals | undefined,
  said: Readonly<Record<string, string[]>> = {},
): Map<string, HunkTag[]> {
  const out = new Map<string, HunkTag[]>();
  if (!tags.length || !signals) return out;
  for (const h of hunksOf(files)) {
    const s: Signals & { chunk: object } = {
      ...signals,
      chunk: { path: h.path, status: files[h.file]!.status, additions: h.additions, deletions: h.deletions },
    };
    const on = tags.flatMap((t): HunkTag[] => {
      const { id, name, bg, fg, ask } = t.config;
      const r = t.when?.eval(s);
      if (r && !(Result.isSuccess(r) && Boolean(r.success))) return [];
      if (ask && !said[h.mark]?.includes(id)) return [];
      return [{ id, name, ...(bg && { bg }), ...(fg && { fg }), by: ask ? "review" : "rule" }];
    });
    if (on.length) out.set(h.mark, on);
  }
  return out;
}
