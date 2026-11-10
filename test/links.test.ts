import { test } from "node:test";
import assert from "node:assert/strict";
import { hashOf, linkRef, permalink, placeOf } from "../src/links.ts";

test("an item's permalink reads as its repo and number, and reads back as its id", () => {
  assert.equal(permalink({ item: "getsentry/sentry#129460" }), "inbox://item/getsentry/sentry/129460");
  assert.deepEqual(placeOf("inbox://item/getsentry/sentry/129460"), { item: "getsentry/sentry#129460" });
  assert.deepEqual(placeOf(" inbox://item/acme/web.js/7/ "), { item: "acme/web.js#7" }, "trimmed, a trailing slash");
  // Another source's id, which isn't owner/repo#n, goes in one piece.
  assert.equal(permalink({ item: "linear:ENG-12" }), "inbox://item/linear%3AENG-12");
  assert.deepEqual(placeOf("inbox://item/linear%3AENG-12"), { item: "linear:ENG-12" });
});

test("each page has a permalink and a route in the window", () => {
  const pages = ["inbox", "blocked", "fyi", "merging", "archive"] as const;
  assert.deepEqual(
    pages.map((page) => permalink({ page })),
    ["inbox://inbox", "inbox://blocked", "inbox://fyi", "inbox://merging", "inbox://archive"],
  );
  assert.deepEqual(
    pages.map((page) => hashOf({ page })),
    ["#/", "#/blocked", "#/later", "#/inflight", "#/archive"],
  );
  assert.deepEqual(placeOf("inbox://Merging"), { page: "merging" });
  assert.equal(hashOf({ item: "acme/api#7" }), "#/item/acme%2Fapi%237");
});

test("an agent's question has a permalink that reads back as its id and routes to its page", () => {
  assert.equal(permalink({ question: "1c0ffee2" }), "inbox://question/1c0ffee2");
  assert.deepEqual(placeOf("inbox://question/1c0ffee2"), { question: "1c0ffee2" });
  assert.deepEqual(placeOf(" inbox://Question/1c0ffee2/ "), { question: "1c0ffee2" }, "trimmed, a trailing slash");
  assert.equal(hashOf({ question: "1c0ffee2" }), "#/inquiry/1c0ffee2");
  assert.deepEqual(placeOf("http://localhost:47823/#/inquiry/1c0ffee2"), { question: "1c0ffee2" });
  for (const s of ["inbox://question/", "inbox://question/a/b", "inbox://question/a%20b"]) assert.equal(placeOf(s), null, s);
});

test("the desk's own http links name the same places, on any local port", () => {
  assert.deepEqual(placeOf("http://localhost:47823/#/review/acme%2Fapi%237"), { item: "acme/api#7" });
  assert.deepEqual(placeOf("http://127.0.0.1:5173/#/item/acme%2Fapi%237"), { item: "acme/api#7" });
  assert.deepEqual(placeOf("http://localhost:47823/#/review/acme/api#7"), { item: "acme/api#7" }, "as an address bar shows it");
  assert.deepEqual(placeOf("http://localhost:47823/#/later"), { page: "fyi" });
  assert.deepEqual(placeOf("http://localhost:47823/#/inflight"), { page: "merging" });
  assert.deepEqual(placeOf("http://localhost:47823"), { page: "inbox" });
  assert.deepEqual(placeOf("http://localhost:47823/#/"), { page: "inbox" });
});

test("what isn't a link to an item or a page names nothing", () => {
  for (const s of [
    "inbox://item/acme/api",
    "inbox://item/acme/api/7/files",
    "inbox://item/%E0%A4%A",
    "inbox://item/",
    "inbox://nowhere",
    "inbox://item/acme/api/7?x=1",
    "http://localhost:47823/#/settings/github",
    "http://localhost:47823/#/review/%E0%A4%A",
    "http://example.com/#/review/acme%2Fapi%237",
    "https://github.com/acme/api/pull/7",
    "acme/api#7",
  ])
    assert.equal(placeOf(s), null, s);
});

test("a ref that's a desk link is its item's id; one naming no item is refused in words, and any other ref is left alone", () => {
  assert.deepEqual(linkRef("inbox://item/acme/api/7"), { id: "acme/api#7" });
  assert.deepEqual(linkRef("http://localhost:47823/#/review/acme%2Fapi%237"), { id: "acme/api#7" });
  assert.deepEqual(linkRef("inbox://blocked"), {
    refused: `"inbox://blocked" is the Blocked page's link, not an item's: give a PR's or an issue's`,
  });
  assert.deepEqual(linkRef(" inbox://item/acme "), {
    refused: `can't read "inbox://item/acme"; an item's link is inbox://item/owner/repo/123`,
  });
  assert.deepEqual(linkRef("http://localhost:3000/foo"), {
    refused: `can't read "http://localhost:3000/foo"; an item's link is inbox://item/owner/repo/123`,
  });
  assert.deepEqual(linkRef("inbox://question/1c0ffee2"), {
    refused: `"inbox://question/1c0ffee2" is a question's link, not an item's: desk_inquiry reads it`,
  });
  for (const ref of ["acme/api#7", "api#7", "#7", "https://github.com/acme/api/pull/7", "http://localhostile.example/#/review/x"])
    assert.equal(linkRef(ref), null, ref);
});

test("the desk's link from another device, at its tailnet address, reads as the item or question it names", () => {
  assert.deepEqual(placeOf("https://desk.tail1234.ts.net/#/review/acme%2Fapi%237"), { item: "acme/api#7" });
  assert.deepEqual(placeOf("https://desk.tail1234.ts.net/#/inquiry/q-1"), { question: "q-1" });
  assert.deepEqual(linkRef("https://desk.tail1234.ts.net/#/item/acme%2Fapi%237"), { id: "acme/api#7" });
  assert.equal(placeOf("https://evil.example/#/review/acme%2Fapi%237"), null);
  assert.equal(linkRef("https://ts.net.evil.example/#/review/x"), null);
});
