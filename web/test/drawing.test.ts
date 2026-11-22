import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { seeded } from "../src/drawing.ts";

const box = { type: "rectangle", x: 10, y: 20, width: 80, height: 30 };
const arrow = {
  type: "arrow",
  x: 90,
  y: 35,
  points: [
    [0, 0],
    [40, 0],
  ],
};

test("a diagram drawn again gets the same seeds, so its strokes don't wobble", () => {
  assert.deepEqual(seeded([box, arrow]), seeded([{ ...box }, { ...arrow }]));
});

test("an element keeps its seed when others around it change", () => {
  const [a] = seeded([box, arrow]);
  const [, b] = seeded([{ ...arrow, x: 5 }, box]);
  assert.equal(a?.seed, b?.seed);
});

test("different elements get different positive seeds", () => {
  const [a, b] = seeded([box, { ...box, x: 11 }]);
  assert.ok(a && b && a.seed > 0 && b.seed > 0);
  assert.notEqual(a.seed, b.seed);
});
