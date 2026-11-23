// The page around the demo: the pile behind it, things to try that take the demo somewhere, Start over, and Copy.
const frame = document.querySelector<HTMLIFrameElement>("#demo");

// ?palette=cobalt and the like, to compare palettes until one is picked.
const palette = new URLSearchParams(location.search).get("palette");
if (palette) document.documentElement.dataset.palette = palette;

// What GitHub sends you in a week, unsorted: the stage's backdrop, repeated so its drift loops.
const PILE = [
  "priya requested your review on acme/api#4127 Stream partial results from the query planner",
  "dependabot[bot] opened acme/tinyhttp#215 Bump undici from 6.19.8 to 6.21.0",
  "CI failed on acme/worker#882 Retry dead-lettered jobs with jittered backoff",
  "@backend was requested to review acme/web#2301 Virtualize the issue stream list",
  "azulus commented on me/notes-app#12 Last-writer-wins sync with tombstones",
  "renovate[bot] opened acme/web#2311 Update dependency vite to v8.0.3",
  "sam approved acme/worker#875 Add idempotency keys to webhook delivery",
  "ana-k requested your review on acme/tinyhttp#212 Support HTTP/2 prior knowledge",
  "github-actions[bot] commented on acme/api#4131 Coverage report: 81.2% (-0.4%)",
  "you were mentioned in acme/infra#540 Rotate the staging database credentials",
  "@platform was requested to review acme/api#4099 Drop the legacy v1 auth middleware",
  "CI passed on acme/ml-pipeline#311 Cache the tokenizer per worker",
  "jules pushed 3 commits to acme/web#2303 Show the export's progress in the toolbar",
  "dependabot[bot] opened acme/api#4140 Bump @types/node from 22.10.1 to 22.10.2",
  "mira closed acme/sentry-javascript#14402 Capture unhandled rejections in edge runtimes",
  "kai requested changes on acme/worker#870 Document queue sizing for large tenants",
  "CI failed on acme/web#2295 Fix the flaky timezone test",
  "@security was requested to review acme/api#1294 Service accounts reach control-silo endpoints",
  "codecov[bot] commented on acme/tinyhttp#205 Add a keep-alive timeout option",
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

const copy = document.querySelector<HTMLButtonElement>("[data-copy]");
copy?.addEventListener("click", () => {
  const text = document.querySelector("#cmd")?.textContent ?? "";
  void navigator.clipboard.writeText(text).then(() => {
    copy.textContent = "Copied";
    return setTimeout(() => {
      copy.textContent = "Copy";
    }, 1500);
  });
});
