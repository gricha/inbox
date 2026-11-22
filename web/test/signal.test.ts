import "../../test/helpers/no-agent.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card } from "../../src/types.ts";
import { RISK_BARS, rowLit } from "../src/risk.ts";

const pr = (extra: Partial<Card>) => ({ id: "a/b#1", kind: "pr", repo: "a/b", number: 1, title: "t", ...extra }) as Card;

test("a row's signal is its review's risk, whatever its size, CI or stage", () => {
  // sentry#131191: low risk, CI green, waiting for review, +462 −18. The review shows four bars; so does its row.
  const big = pr({ stage: "draft", ci: "red", size: { add: 462, del: 18 }, preflight: { risk: "low" } } as Partial<Card>);
  assert.equal(rowLit(big), RISK_BARS.low);
  assert.equal(rowLit(pr({ risk: "medium" })), RISK_BARS.medium);
  assert.equal(rowLit(pr({ preflight: { risk: "high" }, risk: "low" } as Partial<Card>)), RISK_BARS.high, "the queue's read first");
  assert.equal(rowLit(pr({ ci: "green" })), 0, "no review yet: grey");
});
