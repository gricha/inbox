import assert from "node:assert/strict";
import { test } from "node:test";
import { areaFiles, areasFor, buildAreas, dirOf, touched, type AreaPr } from "../src/areas.ts";
import { makeContext, makeItem } from "./helpers/items.ts";

const pr = (paths: string[], authored = false, repo = "getsentry/sentry", files = paths.length): AreaPr => ({
  repo,
  files,
  paths,
  authored,
});

test("a path's directory, up to three levels", () => {
  assert.equal(dirOf("src/sentry/auth/providers/saml2/views.py"), "src/sentry/auth/");
  assert.equal(dirOf("src/sentry/auth/helper.py"), "src/sentry/auth/");
  assert.equal(dirOf("static/app/index.tsx"), "static/app/");
  assert.equal(dirOf("src/index.ts"), "src/");
  assert.equal(dirOf("pyproject.toml"), "");
});

test("areas: your PRs count three reviews, once per directory, a lone review doesn't count, the heaviest first", () => {
  const areas = buildAreas([
    pr(["src/sentry/auth/helper.py", "src/sentry/auth/views.py", "tests/sentry/auth/test_helper.py"], true),
    pr(["src/sentry/auth/helper.py"]),
    pr(["src/sentry/seer/fetch.py"]),
    pr(["src/sentry/seer/fetch.py", "src/sentry/seer/models.py"]),
    pr(["static/app/views/issues.tsx"]), // one review: not yours
    pr(["pyproject.toml", "CODEOWNERS"], true), // top-level files are no area
    pr(["src/Thing.ts"], true, "Acme/Web"),
  ]);
  assert.deepEqual(areas, {
    "getsentry/sentry": { "src/sentry/auth/": 4, "tests/sentry/auth/": 3, "src/sentry/seer/": 2 },
    "acme/web": { "src/": 3 },
  });
  assert.deepEqual(Object.keys(areas["getsentry/sentry"] ?? {}), ["src/sentry/auth/", "tests/sentry/auth/", "src/sentry/seer/"]);
});

test("areas: mass changes are left out and each repo keeps its top 40", () => {
  const codemod = pr(
    Array.from({ length: 50 }, (_, i) => `src/sentry/m${i}/x.py`),
    true,
    "getsentry/sentry",
    400,
  );
  assert.deepEqual(buildAreas([codemod]), {});
  const many = Array.from({ length: 45 }, (_, i) => pr([`src/d${String(i).padStart(2, "0")}/x.py`], true));
  const kept = Object.keys(buildAreas([...many, pr(["src/d44/y.py"], true)])["getsentry/sentry"]!);
  assert.equal(kept.length, 40);
  assert.equal(kept[0], "src/d44/");
});

test("areasFor, areaFiles and touched: unknown until both your areas and the PR's paths are", () => {
  const ctx = makeContext({ areas: { "getsentry/sentry": { "src/sentry/seer/": 2, "src/sentry/auth/": 9 } } });
  assert.deepEqual(areasFor(ctx, "GetSentry/Sentry"), [
    { dir: "src/sentry/auth/", weight: 9 },
    { dir: "src/sentry/seer/", weight: 2 },
  ]);
  assert.deepEqual(areasFor(ctx, "getsentry/relay"), []);
  assert.deepEqual(areasFor(null, "getsentry/sentry"), []);

  const item = makeItem({
    repo: "getsentry/sentry",
    paths: [
      "src/sentry/auth/helper.py",
      "src/sentry/auth/providers/saml2/views.py",
      "static/app/views/a.tsx",
      "static/app/views/b.tsx",
      "static/app/views/c.tsx",
      "src/sentry/seer/fetch.py",
      "setup.cfg",
    ],
  });
  assert.equal(areaFiles(item, ctx), 3);
  assert.deepEqual(touched(item, ctx), [
    { dir: "src/sentry/auth/", files: 2, mine: true },
    { dir: "src/sentry/seer/", files: 1, mine: true },
    { dir: "static/app/views/", files: 3, mine: false },
    { dir: "/", files: 1, mine: false },
  ]);
  assert.equal(areaFiles({ ...item, repo: "getsentry/relay" }, ctx), 0);

  const old = makeItem({ repo: "getsentry/sentry" }); // stored before paths were fetched
  assert.equal(areaFiles(old, ctx), -1);
  assert.equal(touched(old, ctx), null);
  assert.equal(areaFiles(item, makeContext()), -1); // areas not fetched yet
  assert.equal(touched(item, null), null);
});
