# Review documents (`inbox.review/1`)

A review document is one AI review as a self-contained JSON file.

- The desk writes one for every AI review it makes.
- An agent outside the desk (a Claude Code, Codex or OpenCode session) can write one in the same shape.
- Any client can render one. The desk renders each to one HTML page with the review page's look (words, order, tokens, light and dark), with no script and no network.

Code: the format and its checks in `src/doc.ts` (`readDoc`, `docOf`, `saveDoc`); the page in `src/render.ts` (`renderDoc`, `renderText`); the diagram geometry, shared with the window, in `src/diagram-layout.ts`; the page's own CSS in `web/src/doc.css`.

## Storage

- Files, not the database: `<home>/docs/<id>.json` (the document) and `<home>/docs/<id>.html` (its page). `<home>` is `~/.inbox`, or `DESK_HOME`.
- Anything can read them, a page can be sent as it is, and neither needs the desk running.
- The id is the first 16 hex characters of the sha256 of the document as kept. The same document always lands in the same files.
- The desk's AI review for an item (kv `review:<item>`) names its document in `doc`.
- Nothing prunes `docs/` yet.

## Making and reading one

| Who                   | How                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The desk              | Every AI review it writes (`Desk.runAi()`). On demand for a PR's current review: `POST /api/review/:id/doc`, or `desk_doc` with `ref`.                         |
| An agent, with a desk | `desk_doc` with `doc` or `path`, or `POST /api/docs` with the document as the body. Answers `{ id, json, html, link, dropped }`.                               |
| An agent, without one | `desk render <doc.json> [-o out.html]` writes the page beside the file (`-o -`: stdout). `desk_doc` with the desk down renders into the desk's home itself.    |
| Reading               | `GET /api/docs/:id` (JSON), `GET /api/docs/:id/html` (page), `inbox://doc/<id>` (the desktop app opens `#/doc/<id>`, framed so it runs nothing), or the files. |

## The document

```json
{
  "format": "inbox.review/1",
  "pr": {
    "title": "Split the scheduler",
    "repo": "acme/worker",
    "number": 879,
    "url": "https://github.com/acme/worker/pull/879",
    "author": "kofi",
    "head": "9f2c…"
  },
  "by": "a Claude Code session",
  "at": "2026-11-10T12:00:00Z",
  "files": [{ "path": "src/lease.ts", "previous_path": null, "status": "modified", "patch": "@@ -1,3 +1,5 @@\n export class Lease {\n…" }],
  "review": { "risk": "medium", "verdict": "look", "summary": "…", "…": "…" }
}
```

| Field    | Rules                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format` | `"inbox.review/1"`. Any other value is refused. Fields this version doesn't name are dropped.                                                                                                                      |
| `pr`     | `title` required, ≤300. Optional: `repo` (`owner/name`), `number` (positive integer), `url` (https only), `author` (a login), `head` (a commit sha). It needn't be a PR: a local diff can have a title alone.      |
| `by`     | Who wrote the review, ≤80 characters. Default `"an agent"`. The desk's own say `Inbox, <model>`.                                                                                                                   |
| `at`     | When, ISO 8601. Default: now.                                                                                                                                                                                      |
| `files`  | The changed files in order, 1 to 300, each path once. `path`; `previous_path` (a rename's); `status`: `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged` (default `modified`); `patch`. |
| `review` | The review, in the shape the desk's own AI review answers in (`SCHEMA` in `src/review.ts`; what each part is for: the review skill in `src/connectors/github-review.ts`). Fields below.                            |

`patch` is the unified hunks as GitHub's `pulls/{n}/files` gives them, starting at the first `@@` line. Use `null` for a binary file; then `additions` and `deletions` are taken as given (otherwise they're counted from the patch).

Size limits: one patch ≤200,000 characters, all patches ≤1,000,000, the whole document ≤4 MB.

### `review`

| Field          | What                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `risk`         | `low`, `medium` or `high` (default `medium`). Sets the budget for everything below.                                                                                                                                                                                                                          |
| `risk_reasons` | `[{ factor, why }]`. `factor`: `data`, `security`, `contract`, `concurrency`, `deploy`, `irreversible`, `reach`, `untested` or `other`. `why` ≤100.                                                                                                                                                          |
| `intent`       | `{ goal, fit, gap, stack }`, each ≤300. `fit`: `matches`, `partial`, `differs` or `undescribed` (default). `gap` (what the description doesn't say) is kept only for `partial` and `differs`. Ignored without a `goal`.                                                                                      |
| `verdict`      | `look`, `skim` or `skip` (default `skim`). A `high` risk's `skip` becomes `skim`.                                                                                                                                                                                                                            |
| `summary`      | Required. Markdown-ish prose: paragraphs, lists, `code`, `**bold**`, fences. Its first sentence leads when there's no `goal`.                                                                                                                                                                                |
| `since`        | For a re-review: what changed since the reader last looked, or `""`.                                                                                                                                                                                                                                         |
| `concerns`     | `[{ path, side, line, quote, body }]`: defects. `body` ≤1,200. Each is also drawn on its line.                                                                                                                                                                                                               |
| `look`         | `[{ path, side, line, end, quote, why }]`: lines to read even if nothing else. `why` ≤100. Must sit on a line of a hunk the prompt would show; `end` is clipped to that hunk and to 15 lines.                                                                                                                |
| `interfaces`   | `[{ path, side, line, quote, name, kind, change, breaking, impact }]`. `name` ≤80 and `impact` ≤300, both required. `kind`: `function`, `type`, `endpoint`, `schema`, `config`, `event`, `cli`, `permission` or `other` (default). `change`: `added`, `changed` (default) or `removed`. `breaking`: boolean. |
| `improvements` | `[{ path, side, line, quote, body }]`. `body` ≤600.                                                                                                                                                                                                                                                          |
| `notes`        | `[{ path, side, line, quote, body }]`, on the line they're about. `body` ≤600. Line 0 is about the whole file.                                                                                                                                                                                               |
| `chunks`       | `[{ id, level, why }]`: the hunks worth reading, most worth first. `id` is `h1`, `h2`, … counted across the files in order. `level`: `look` or `skim`. `why` ≤80. Each hunk once.                                                                                                                            |
| `steps`        | `[{ title, body, check, note, diagram, hunks }]`: the walk-through. `title` ≤60 (required), `body` ≤300, `check` ≤200, `note` ≤500. `hunks`: hunk ids in reading order, at least one. `diagram`: a diagram's id or `""`.                                                                                     |
| `diagrams`     | `[{ id, title, caption, source, graph }]`. `id` matches `[A-Za-z][\w-]{0,15}`. `title` ≤60, `caption` ≤200. `source`: Mermaid (see [Diagrams](#diagrams)). `graph`: its parse, which the desk writes; a renderer may use it but never trusts it.                                                             |

### Anchors

- `path`: a file in `files`. A unique suffix after a `/` also works (`lease.ts` for `src/lease.ts`).
- `side`: `new` is a line of the new file (added or unchanged); `old` is a removed line.
- `line`: the line number on that side. A line that isn't in the diff moves the comment to the whole file (line 0).
- `quote`: the line or lines of the diff the comment rests on, copied without the `+`/`-` sign. It's the evidence. Every quoted line must be code in that file's diff (a whole line or part of one), and at least one must contain a letter or digit. A comment whose quote fails this is left out.

## Checks and caps

A document goes through the same parsers as the desk's own AI review (`readAnswer()`: `readReview` then `keep` in `src/review.ts`; `parseDiagram` in `src/diagram.ts`), so it gets the same checks and caps.

- What doesn't hold is **left out** and listed in `dropped` (the CLI prints each as `left out: …`).
- What the desk can't read **refuses** the whole document, with why.

**Left out:**

- a comment whose `quote` isn't in its file's diff, or whose `path` names no file;
- whatever is over the risk's budget (below);
- a ranked hunk or a step's hunk the desk's own prompt wouldn't have shown: past 80,000 characters of diff, past 20,000 of one file, or in a lockfile or snapshot;
- a step with no title or no usable hunk; a hunk already in an earlier step;
- the whole walk-through, when fewer than two steps hold or they cover under half of the ranked hunks;
- a step's `diagram` that names no kept diagram; a second diagram with the same id;
- text past its field's length (cut, not dropped).

A hunk with a note on it that isn't ranked is added to `chunks` as `skim`.

**Budgets** (`BUDGETS` in `src/connectors/github-review.ts`). "In the code" counts concerns, look, notes and improvements together, filled in that order.

| Risk   | In the code | Concerns | Look | Improvements | Risk reasons | Interfaces | Ranked hunks | Steps | Step notes | Diagrams |
| ------ | ----------- | -------- | ---- | ------------ | ------------ | ---------- | ------------ | ----- | ---------- | -------- |
| low    | 3           | 1        | 1    | 1            | 0            | 2          | 8            | 3     | 1          | 1        |
| medium | 6           | 3        | 2    | 1            | 2            | 3          | 12           | 5     | 2          | 1        |
| high   | 12          | 6        | 3    | 3            | 3            | 5          | 20           | 8     | 3          | 2        |

**Refused:**

- not a JSON object, or over 4 MB;
- another `format`;
- no `pr.title`; a `pr.repo`, `number`, `url` (not https), `author` or `head` in the wrong form;
- no files, more than 300, a path listed twice, a patch that doesn't start with a hunk, or the size limits above;
- `review` not an object, or no `summary`;
- a diagram with no `source`, an id outside `[A-Za-z][\w-]{0,15}`, or a source outside the grammar below.

A kept document is what `readDoc()` made of it, so reading it again changes nothing. The desk's own reviews take the same road (`docOf()`), so its documents are exactly what an agent's would be.

## Diagrams

A strict subset of Mermaid (`src/diagram.ts`): every diagram is valid Mermaid, and nothing in it is ever run. The source is at most 2048 bytes. One line the parser can't read fails the whole diagram.

- **`flowchart LR` or `TB`** (`graph` and `TD` also accepted)
  - Nodes: `id["label"]`, `id[("label")]` (a store), `id{"label"}` (a decision), `id(["label"])` (an end), `id(("label"))` (a circle).
  - Edges: `-->`, `-.->` or `---`. Labelled: `-->|"label"|`, `-- "label" -->` or `-. "label" .->`. Chains (`a --> b --> c`) work.
  - `subgraph id ["label"]` … `end`, one level.
  - Marks: `:::new`, `:::changed`, `:::removed`, or `class a,b new`.
- **`stateDiagram-v2`** (or `stateDiagram`): `[*] --> A`, `A --> B : event`, `state "Label" as A`.
- **`sequenceDiagram`**: `participant X as Label` or `actor X`; `A->>B: text`; `A-->>B: text` (a reply); `Note over A: text` or `Note over A, B: text`.

Rules for all:

- Ids: a letter, then up to 23 letters, digits or `_`. Not `end`.
- Labels: one line, at most 40 characters (a message or note: 48). Quote them; plain words without brackets or quotes also parse. Never HTML: a `<tag>` fails the diagram.
- Size: 3 to 12 nodes and at most 16 edges; or 3 to 6 participants and at most 14 messages and notes.
- `classDef`, `style`, `linkStyle` and `click` lines are dropped unread. `%%` comments are skipped. Anything else (`init`, other diagram types, HTML) fails the diagram.

## A renderer

The desk's page (`renderDoc()`) is the reference. A renderer must:

- read a document through these checks, or render only one the desk kept (`GET /api/docs/:id`), and refuse any other `format`;
- treat every string as text: never HTML, a style or a script. A link in prose shows the https URL it goes to and is drawn as text (the PR's author can steer the review's words);
- draw a diagram from its `source` as parsed by this grammar, from `graph` only when it can't parse, and never from anything else;
- fetch nothing. The desk's page carries its CSS and fonts inline, has no script, and says so with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:`.

How the desk's page is built:

- Diagrams are laid out with ELK in Node and drawn as static SVG by the same code the window's worker uses (`src/diagram-layout.ts`). Text is measured with Instrument Sans widths from `src/metrics.ts` (written from Chrome by `node scripts/metrics.ts`). A diagram that won't lay out is drawn as a list of its edges.
- Its CSS is the window's: the Light and Dark tokens, plus every rule in `web/src/styles.css` whose selector starts with a class or element the page uses (`USED` in `src/render.ts`), in order. Then `web/src/doc.css` for the page itself and its diff.
