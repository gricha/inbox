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

test("a reviewer's link reads as its words, an image is one, a linked image is a link in its alt; only https", () => {
  const html =
    'See <a href="https://cursor.com/open?link=abc" target="_blank"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/a.png"><img alt="Fix All in Cursor" width="115" src="https://cursor.com/b.png"></picture></a> or [the docs](https://example.com/docs).';
  const [p] = saidBlocks(html);
  assert.ok(p?.t === "p");
  assert.deepEqual(
    p.spans.map((s) => (s.t === "link" ? [s.label, s.url, s.img ?? false] : s.text)),
    [
      "See ",
      ["Fix All in Cursor", "https://cursor.com/open?link=abc", false],
      " or ",
      ["the docs", "https://example.com/docs", false],
      ".",
    ],
  );
  const [img] = saidBlocks(
    '<img alt="shot" src="https://github.com/user-attachments/assets/1"> ![](https://github.com/user-attachments/assets/2)',
  );
  assert.ok(img?.t === "p");
  assert.deepEqual(
    img.spans.filter((s) => s.t === "link").map((s) => [s.label, s.img]),
    [
      ["shot", true],
      ["image", true],
    ],
  );
  const [bad] = saidBlocks('<a href="javascript:alert(1)">x</a>');
  assert.ok(bad?.t === "p" && bad.spans.every((s) => s.t === "text"));
});
