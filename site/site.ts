import { compact } from "./stars.ts";

// The page around the demo: the pile behind it, things to try that take the demo somewhere, Start over, and Copy.
const frame = document.querySelector<HTMLIFrameElement>("#demo");

// Everything that wants you in a day, unsorted: the stage's backdrop, repeated so its drift loops.
const PILE = [
  "priya requested your review on acme/api#4127 Stream partial results from the query planner",
  "Claude Code is waiting: allow Bash(npm test) in acme/api?",
  "dependabot[bot] opened acme/tinyhttp#215 Bump undici from 6.19.8 to 6.21.0",
  "Mina in #design: can you look at the onboarding copy before Friday?",
  "CI failed on acme/worker#882 Retry dead-lettered jobs with jittered backoff",
  "Codex finished: 3 files changed in me/notes-app, waiting for your review",
  "Dana Okafor: the venue needs the deposit confirmed by tomorrow",
  "@backend was requested to review acme/web#2301 Virtualize the issue stream list",
  "azulus commented on me/notes-app#12: why do tombstones never go away?",
  "Your agent asks: compact tombstones in #12, or ship it and follow up?",
  "renovate[bot] opened acme/web#2311 Update dependency vite to v8.0.3",
  "Northwind Card: your November statement is ready",
  "sam approved acme/worker#875 Add idempotency keys to webhook delivery",
  "#incidents: search latency p95 over budget in eu-west",
  "ana-k requested your review on oss/tinyhttp#212 Support HTTP/2 prior knowledge",
  "Background session stopped: rate limited until 12:05",
  "kai requested changes on acme/worker#870 Document queue sizing for large tenants",
  "Calendar: design review moved to 3:30",
  "github-actions[bot] commented on acme/api#4131 Coverage report: 81.2% (-0.4%)",
  "Linear: INF-2291 assigned to you",
];

const pile = document.querySelector(".pile");
if (pile) {
  const rows = document.createElement("div");
  rows.className = "pile-rows";
  for (let i = 0; i < 6; i++)
    for (const line of PILE) {
      const row = document.createElement("div");
      row.textContent = line;
      rows.append(row);
    }
  pile.append(rows);
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-go]")) {
  b.addEventListener("click", () => {
    const win = frame?.contentWindow;
    if (!win || !b.dataset.go) return;
    win.location.hash = b.dataset.go;
    frame.scrollIntoView({ block: "nearest", behavior: "smooth" });
    frame.focus();
  });
}

document.querySelector("[data-reset]")?.addEventListener("click", () => {
  const win = frame?.contentWindow;
  if (!win) return;
  win.history.replaceState(null, "", "/demo/");
  win.location.reload();
});

// Each Copy copies the text in its own box.
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  button.addEventListener("click", () => {
    const text = button.parentElement?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      button.textContent = "Copied";
      return setTimeout(() => {
        button.textContent = "Copy";
      }, 1500);
    });
  });
}

// The live star count, over the one the build put in; GitHub not answering leaves that one.
async function liveStars(el: Element) {
  const res = await fetch("https://api.github.com/repos/gricha/inbox").catch(() => null);
  const body: unknown = res?.ok ? await res.json().catch(() => null) : null;
  const n = body && typeof body === "object" && "stargazers_count" in body ? body.stargazers_count : null;
  if (typeof n === "number") el.textContent = compact(n);
}
const count = document.querySelector("[data-stars]");
if (count) void liveStars(count);
