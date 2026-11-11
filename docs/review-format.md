# Review documents (`inbox.review/1`)

One AI review as a self-contained JSON document, so a review isn't locked in the desk's window and database: the desk writes one for every AI review it makes, an agent outside the desk (a Claude Code or Codex session) can write one in the same shape, and any client can render it. The desk renders each to one HTML page with the review page's look: the same words, order, tokens and rules, light and dark, and no script or network.

The code: the format and its checks in `src/doc.ts` (`readDoc`, `docOf`, `saveDoc`), the page in `src/render.ts` (`renderDoc`, `renderText`), the diagram geometry the window shares in `src/diagram-layout.ts`, the page's own CSS in `web/src/doc.css`.

## Storage

Files, not the database: `<home>/docs/<id>.json` (the document) and `<home>/docs/<id>.html` (its page), where `<home>` is the desk's (`~/.inbox`, or `DESK_HOME`). Any tool or agent can read them, a page can be sent as it is, and nothing about them needs the desk running. The id is the first 16 hex characters of the sha256 of the document as kept, so sending the same document twice is one file, and a file is never rewritten. The AI review the desk keeps under `review:<item>` names its document in `doc`. Nothing prunes `docs/` yet.

## Making and reading one

| Who                   | How                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The desk              | every AI review it writes (`Desk.runAi()`), and on demand for a PR's current one: `POST /api/review/:id/doc`, or `desk_doc` with `ref`                                            |
| An agent, with a desk | `desk_doc` with `doc` or `path`, or `POST /api/docs` with the document as the body: kept, rendered, answered with `{ id, json, html, link, dropped }`                             |
| An agent, without one | `desk render <doc.json> [-o out.html]` writes the page beside it (or to `-o`, `-` for stdout); `desk_doc` with the desk down renders into the desk's home all the same            |
| Reading it            | `GET /api/docs/:id` (the JSON), `GET /api/docs/:id/html` (the page), `inbox://doc/<id>` (the desktop app opens `#/doc/<id>`, the page in a frame that runs nothing), or the files |

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

- `format`: `"inbox.review/1"`. Another version is refused; a field this version doesn't name is dropped.
- `pr`: `title` (required, ≤300), and as known: `repo` (`owner/name`), `number`, `url` (https only), `author` (a login), `head` (the commit's sha). It needn't be a PR: a local diff has a title alone.
- `by`: who wrote the review, ≤80 characters ("an agent" when missing). The desk's own say `Inbox, <model>`. `at`: when, ISO 8601 (now when missing).
- `files`: the changed files, in order, 1 to 300: `path`, `previous_path` (a rename's), `status` (`added`, `removed`, `modified`, `renamed`, `copied`, `changed`, `unchanged`), and `patch`: the unified hunks as GitHub's `pulls/{n}/files` gives them, starting at the first `@@` line, or `null` for a binary file (then `additions` and `deletions` are taken as given). A patch is at most 200,000 characters, all of them 1,000,000; the whole document at most 4 MB.
- `review`: the review in the shape the desk's own AI review answers in (the `SCHEMA` in `src/review.ts`; what each part is for is the review skill in `src/connectors/github-review.ts`):

| Field          | What                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `risk`         | `low`, `medium` or `high`: it sets the budget for everything below                                                                                                                                                                      |
| `risk_reasons` | `[{ factor, why }]`: factor one of `data`, `security`, `contract`, `concurrency`, `deploy`, `irreversible`, `reach`, `untested`, `other`; why ≤100                                                                                      |
| `intent`       | `{ goal, fit, gap, stack }`: what the PR is for; `fit` one of `matches`, `partial`, `differs`, `undescribed`; `gap` (only for `partial` and `differs`) what the description doesn't say; `stack`, where it sits in its stack; each ≤300 |
| `verdict`      | `look`, `skim` or `skip` (a high risk is never `skip`)                                                                                                                                                                                  |
| `summary`      | required: Markdown-ish prose (paragraphs, lists, `code`, `**bold**`, fences); the first sentence leads when there's no `goal`                                                                                                           |
| `since`        | a re-review: what changed since the reader last looked, or `""`                                                                                                                                                                         |
| `concerns`     | `[{ path, side, line, quote, body }]`: defects; each is also drawn on its line                                                                                                                                                          |
| `look`         | `[{ path, side, line, end, quote, why }]`: the lines to read even if nothing else, at most 15 in one hunk                                                                                                                               |
| `interfaces`   | `[{ path, side, line, quote, name, kind, change, breaking, impact }]`                                                                                                                                                                   |
| `improvements` | `[{ path, side, line, quote, body }]`                                                                                                                                                                                                   |
| `notes`        | `[{ path, side, line, quote, body }]`: on the line they're about; line 0 is about the whole file                                                                                                                                        |
| `chunks`       | `[{ id, level, why }]`: the hunks worth reading, most worth first; `id` is `h1`, `h2`, … across the files in order, `level` `look` or `skim`, why ≤80                                                                                   |
| `steps`        | `[{ title, body, check, note, diagram, hunks }]`: the walk-through, each step's hunk ids in reading order and a diagram's id or `""`                                                                                                    |
| `diagrams`     | `[{ id, title, caption, source, graph }]`: `source` is the Mermaid below; `graph` is its parse, which the desk writes and a renderer may use, never trusts                                                                              |

Anchors: `side` `new` is a line of the new file (added or unchanged), `old` a removed one. `quote` is the line (or lines) of the diff the comment rests on, copied exactly without the +/- sign: it's the evidence, and a comment whose quote isn't code in that file's diff is left out.

## The checks and caps

A document is read through the same parsers as the desk's own AI review (`readAnswer()`: `readReview` then `keep` in `src/review.ts`; `parseDiagram` in `src/diagram.ts`), so it gets the same checks and the same caps. What doesn't hold is left out and listed in `dropped` (the CLI prints it as "left out: …"); what the desk can't read refuses the whole document, with why:

- **Left out**: a comment whose `quote` isn't in its file's diff, or whose `path` names no file in it; whatever is over the risk's budget (low: 3 things in the code, 1 concern, 1 look, 1 improvement, no risk reasons, 2 interfaces, 8 ranked hunks, 3 steps, 1 diagram; medium: 6, 3, 2, 1, 2, 3, 12, 5, 1; high: 12, 6, 3, 3, 3, 5, 20, 8, 2; `BUDGETS` in `src/connectors/github-review.ts`); a ranked hunk or a step's hunk the desk's own prompt wouldn't have shown (past 80,000 characters of diff, or 20,000 of one file); the whole walk-through when fewer than two steps hold or they cover under half of what's ranked; text past its field's length.
- **Refused**: not a JSON object, another `format`, no `pr.title`, a `pr.url` that isn't https, no files, a patch that doesn't start with a hunk, the limits above, no `summary`, a diagram with no `source`, an id outside `[A-Za-z][\w-]{0,15}`, or a source outside the grammar below.

A document the desk keeps is what `readDoc()` made of it: reading it again changes nothing. The desk's own reviews take the same road (`docOf()`), so its documents are what an agent's would be.

## Diagrams

Mermaid, a strict subset (`src/diagram.ts`), so every diagram is valid Mermaid too and nothing in it is ever run. At most 2048 bytes; one line it can't read fails the whole diagram.

- `flowchart LR` or `TB` (`graph`, `TD` too): nodes `id["label"]`, `id[("label")]` (a store), `id{"label"}` (a decision), `id(["label"])` (an end), `id(("label"))` (a circle); edges `-->`, `-.->` or `---`, labelled `-->|"label"|` or `-- "label" -->`; `subgraph id ["label"]` … `end`, one level; marks `:::new`, `:::changed`, `:::removed`, or `class a,b new`.
- `stateDiagram-v2`: `[*] --> A`, `A --> B : event`, `state "Label" as A`.
- `sequenceDiagram`: `participant X as Label` or `actor X`, `A->>B: text`, `A-->>B: text` (a reply), `Note over A: text` or `Note over A, B: text`.
- Ids: a letter, then up to 23 letters, digits or `_`; not `end`. Labels quoted, one line, at most 40 characters (a message or note 48), and never HTML: a `<tag>` in one fails the diagram.
- At least 3 and at most 12 nodes and 16 edges, or 3 to 6 participants and 14 messages and notes.
- `classDef`, `style`, `linkStyle` and `click` lines are dropped unread; `%%` comments are skipped; anything else (`init`, other diagram types, HTML) fails it.

## A renderer

The desk's page (`renderDoc()`) is the reference. A renderer must:

- read a document through these checks, or render only one the desk kept (`GET /api/docs/:id`), and refuse any other `format`;
- treat every string as text: never HTML, never a style, never a script; a link in prose shows the https URL it goes to and is drawn as text in the review (the PR's author can steer it);
- draw a diagram from its `source` as parsed by the grammar, or from `graph` only when it can't parse, and never from anything outside it;
- fetch nothing: the desk's page carries its CSS and fonts inline, has no script, and says so in a `Content-Security-Policy` of `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:`.

The desk's page lays its diagrams out with ELK in Node, measuring Instrument Sans with the widths in `src/metrics.ts` (written by `node scripts/metrics.ts`, from Chrome), and draws them with the same code as the window's worker does (`src/diagram-layout.ts`). Its CSS is the window's: the Light and Dark tokens and every rule in `web/src/styles.css` whose selector starts with a class the page uses (`USED` in `src/render.ts`), in their order, then `web/src/doc.css` for the page itself and its diff.
