// What a reviewer wrote on GitHub, drawn as text: comments gone, <details> a fold, <sub> small print, lists as lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { saidBlocks, saidLine, type Said, type Span } from "../src/prose.ts";

const WARDEN = `### Service account token creation enables scope escalation

An organization manager with \`service_account:write\` can mint a token.

<details><summary>Evidence</summary>

- \`validate_scopes()\` only checks requested scopes
- \`post()\` returns the plaintext token

</details>

<sub>Identified by Warden · security-review · E22-TBM</sub>
<!-- warden:v1:src/sentry/x.py:235:6ebaf14c
-->
<!-- warden:finding:v1:eyJpZCI6IkUyMi1UQk0i -->`;

const words = (ss: Span[]) => ss.map((s) => (s.t === "link" ? s.url : s.text)).join("");
const shape = (bs: Said[]): unknown =>
  bs.map((b) =>
    b.t === "details"
      ? { details: words(b.summary), in: shape(b.blocks) }
      : b.t === "ul" || b.t === "ol"
        ? { [b.t]: b.items.length }
        : b.t === "pre"
          ? { pre: b.text }
          : { [b.t]: words(b.spans) },
  );

test("a bot's finding: its heading, words, Evidence folded with its list, small print, and no HTML comments", () => {
  assert.deepEqual(shape(saidBlocks(WARDEN)), [
    { p: "Service account token creation enables scope escalation" },
    { p: "An organization manager with service_account:write can mint a token." },
    { details: "Evidence", in: [{ ul: 2 }] },
    { small: "Identified by Warden · security-review · E22-TBM" },
  ]);
  assert.equal(saidLine(WARDEN), "Service account token creation enables scope escalation");
});

test("tags in code stay code, a <br> breaks a line, <b> is bold, and an unknown tag is text", () => {
  assert.deepEqual(shape(saidBlocks("```html\n<b>x</b><br>\n\n<sub>y</sub>\n```")), [{ pre: "<b>x</b><br>\n\n<sub>y</sub>" }]);
  const [p] = saidBlocks("one<br>two <b>three</b> <img src=x>");
  assert.ok(p?.t === "p");
  assert.deepEqual(
    p.spans.map((s) => [s.t === "link" ? s.url : s.text, s.bold]),
    [
      ["one\ntwo ", false],
      ["three", true],
      [" <img src=x>", false],
    ],
  );
});
