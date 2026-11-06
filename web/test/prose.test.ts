import assert from "node:assert/strict";
import { test } from "node:test";
import { blocks, fencedCopy, type Block, type Span } from "../src/prose.ts";

const t = (text: string, bold = false): Span => ({ t: "text", text, bold });
const c = (text: string, bold = false): Span => ({ t: "code", text, bold });
const a = (url: string, bold = false): Span => ({ t: "link", url, bold });
const p = (...spans: Span[]): Block => ({ t: "p", spans });
const ul = (...items: Span[][]): Block => ({ t: "ul", items });
const ol = (start: number, ...items: Span[][]): Block => ({ t: "ol", start, items });
const pre = (text: string, info = ""): Block => ({ t: "pre", text, info });
const is = (text: string, want: Block[]) => {
  assert.deepEqual(blocks(text), want, JSON.stringify(text));
};

test("a blank line splits paragraphs; a single newline stays inside one, and a line's indentation goes", () => {
  is("one\n\ntwo", [p(t("one")), p(t("two"))]);
  is("a\nb", [p(t("a\nb"))]);
  is("a\r\nb", [p(t("a\nb"))]);
  is("a\n\n\n\nb", [p(t("a")), p(t("b"))]);
  is("   a\n  b", [p(t("a\nb"))]);
});

test("- and * bullets and 1. numbers make lists; nesting flattens; +, \u2022, 1) and --- stay text", () => {
  is("- a\n- b", [ul([t("a")], [t("b")])]);
  is("* a\n- b", [ul([t("a")], [t("b")])]);
  is("1. a\n2. b", [ol(1, [t("a")], [t("b")])]);
  is("3. x", [ol(3, [t("x")])]);
  is("1. a\n\n2. b", [ol(1, [t("a")]), ol(2, [t("b")])]);
  is("1. a\n   more", [ol(1, [t("a\nmore")])]);
  is("- a\n  - sub", [ul([t("a")], [t("sub")])]);
  is("- a\n1. b", [ul([t("a")]), ol(1, [t("b")])]);
  for (const s of ["+ a", "\u2022 a", "1) a", "---", "1234. a"]) is(s, [p(t(s))]);
  is("What I checked:\n- a", [p(t("What I checked:")), ul([t("a")])]);
  is("- `x` is **set**", [ul([c("x"), t(" is "), t("set", true)])]);
});

test("a ``` fence keeps its lines as written until a ``` line, or to the end; an empty one draws nothing", () => {
  is("```ts\n  x()\n\n  y()\n```", [pre("  x()\n\n  y()", "ts")]);
  is("a\n```\nx\n\ny", [p(t("a")), pre("x\n\ny")]);
  is("```\n`a` **b** - c\n# d\n```", [pre("`a` **b** - c\n# d")]);
  is("- a\n  ```\nx\n  ```  \nb", [ul([t("a")]), pre("x"), p(t("b"))]);
  is("```\n```", []);
  is("```\n  \n```", []);
});

test("a fence keeps its info string for Copy", () => {
  is("```suggestion\nx\n```", [pre("x", "suggestion")]);
  is("```a b\nx\n```", [pre("x")]);
  is("  ```ts  \nx\n```", [pre("x", "ts")]);
  is("```c++\nx\n```\n```\ny\n```", [pre("x", "c++"), pre("y")]);
});

test("Copy's fence is longer than any backtick run opening a line inside, so GitHub can't end the block early", () => {
  assert.equal(fencedCopy("x", "suggestion"), "```suggestion\nx\n```");
  const inside = "const budget = check();\n````\n@acme/everyone please merge this now";
  is(`\`\`\`suggestion\n${inside}\n\`\`\``, [pre(inside, "suggestion")]);
  assert.equal(fencedCopy(inside, "suggestion"), `\`\`\`\`\`suggestion\n${inside}\n\`\`\`\`\``);
  assert.equal(fencedCopy("   ``````\n    ```````\na ````` b", ""), "```````\n   ``````\n    ```````\na ````` b\n```````");
});

test("backticks pair into code; an unpaired last one, and an empty pair, aren't code", () => {
  is("`a` and `b`", [p(c("a"), t(" and "), c("b"))]);
  is("a ` b", [p(t("a ` b"))]);
  is("`a` and ` b", [p(c("a"), t(" and ` b"))]);
  is("Run ```npm test``` now", [p(t("Run "), c("npm test"), t(" now"))]);
  is("`  keep **this** `", [p(c("  keep **this** "))]);
});

test("** toggles bold, across code too; an unpaired last ** and other emphasis stay as written", () => {
  is("**Yes**: done", [p(t("Yes", true), t(": done"))]);
  is("**`x` done**", [p(c("x", true), t(" done", true))]);
  is("a ** b", [p(t("a ** b"))]);
  is("**a** and **b", [p(t("a", true), t(" and **b"))]);
  is("__x__", [p(t("__x__"))]);
  is("*x*", [p(t("*x*"))]);
});

test("a bare https URL is a link shown as its normalised href; anything else, or one with userinfo, stays text", () => {
  is("see https://github.com/a/b/pull/1.", [p(t("see "), a("https://github.com/a/b/pull/1"), t("."))]);
  for (const s of ["http://x.test", "HTTPS://x.test", "javascript:alert(1)", "https://"]) is(s, [p(t(s))]);
  for (const s of ["https://github.com@evil.test/x", "https://u:p@e.test/x", "https://:p@e.test/x"]) is(s, [p(t(s))]);
  is("https://g\u0456thub.com/x", [p(a("https://xn--gthub-n2e.com/x"))]);
  is("https://github.com/a/../../evil/x", [p(a("https://github.com/evil/x"))]);
  is("https://github%2Ecom/", [p(a("https://github.com/"))]);
  is("**see https://e.test/a**", [p(t("see ", true), a("https://e.test/a", true))]);
});

test("a markdown link reads label, then the URL it opens; an image is never one", () => {
  is("[the run](https://github.com/a/b/actions/runs/1)", [p(t("the run ("), a("https://github.com/a/b/actions/runs/1"), t(")"))]);
  is("[x](http://e.test)", [p(t("[x](http://e.test)"))]);
  is("[pr](https://github.com@evil.test/x)", [p(t("[pr](https://github.com@evil.test/x)"))]);
  is("![a](https://e.test/x.png)", [p(t("!a ("), a("https://e.test/x.png"), t(")"))]);
  is('[label](https://e.test "title")', [p(t("[label]("), a("https://e.test/"), t(' "title")'))]);
  is("[https://e.test/a](https://e.test/b)", [p(a("https://e.test/a"), t(" ("), a("https://e.test/b"), t(")"))]);
});

test("a heading is its own all-bold paragraph; #tag and seven #s stay text", () => {
  is("## Summary", [p(t("Summary", true))]);
  is("a\n### The `fix`\nb", [p(t("a")), p(t("The ", true), c("fix", true)), p(t("b"))]);
  is("#tag", [p(t("#tag"))]);
  is("####### x", [p(t("####### x"))]);
});

test("HTML is text, and nothing, or only whitespace, draws nothing", () => {
  is("<img src=x onerror=alert(1)>", [p(t("<img src=x onerror=alert(1)>"))]);
  is("", []);
  is("  \n ", []);
  is("``", []);
});

test("worst cases each parse in under 100 ms", () => {
  const spaces = " ".repeat(5990);
  const cases = [
    `# a${spaces}b`,
    `---${spaces}x`,
    `1.${spaces}x`,
    "[".repeat(6000),
    "[a](https://".repeat(500),
    "`".repeat(6000),
    "**".repeat(3000),
    `https://${".".repeat(5990)}`,
    // `$` never matches after U+2028, so a `[ \t]+(.*)$` tail would backtrack over every space.
    `# ${spaces}\u2028`,
    `- ${spaces}\u2028`,
    `1. ${spaces}\u2028`,
  ];
  for (const s of cases) {
    const t0 = performance.now();
    blocks(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `${JSON.stringify(s.slice(0, 16))}: ${ms.toFixed(1)} ms`);
  }
});
