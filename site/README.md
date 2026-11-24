# useinbox.dev

The website: one page, with the real Inbox window running in it. The demo at `/demo/` is `web/src` unchanged, talking to the
repo's mock desk (`web/mock/desk.ts`) inside the visitor's tab: `site/demo/desk.ts` answers the window's `fetch` and
`EventSource`, and `site/demo/node/` stands in for the Node builtins the mock's modules import. Each visitor has their own
desk; a reload starts it again. Nothing leaves the page.

```bash
npm run site         # the site on Vite at :5190
npm run site:build   # site/dist: static files for Cloudflare
npm run site:deploy  # build, then wrangler deploy to useinbox.dev (site/wrangler.jsonc)
```

## The page

The landing page is the demo: the live app fills the first screen, on desktop and on a phone. The story is attention, not
GitHub: code reviews are one source beside your agents' questions and stuck sessions and what automations bring in.

- **The stage.** Behind the app drifts the raw pile of what wants you (review requests, CI, an agent asking for a
  permission, mail, chat mentions); in front, the live app shows it as one short list. That contrast is the page's one bold
  idea; everything else stays quiet.
- **The first screen** is the demo: the headline "Attention is all you've got" (Instrument Sans, the app's own face, 700
  at 75% width) centred above it, then the live app, large, with a margin on each side. Under it: the paragraph, and the
  four things to try in a 2×2 grid (each takes the demo to a place; the action stays the visitor's) with Start the demo
  over. On a phone the same, in one column.
- **Below the stage:** Install (one command; `/install` redirects to the repo's `install.sh`), three facts (runs on your
  machine; uses your agent; writes when you say so), and a footer.
- **Light and Dark follow the system,** page and app alike. Violet, the logo's `#6a3dbd`: a pale `#efeaf8` stage in Light,
  a deep `#1d1733` one in Dark. JetBrains Mono only for the pile and the command.
- **Left out on purpose:** features grid, screenshots, themes showcase, video, testimonials, pricing, newsletter, cookie
  banner, analytics, docs site (the README is the docs).

## The demo's list

`MOCK_DEMO` in `web/mock/desk.ts` keeps it short. Urgent: your agent's question, a session waiting on a permission, and
Priya's planner PR. Standard: your approved PR to hand off, an easy review, your sync PR with an open thread, your draft.
FYI: a docs PR and two notes automations sorted there (mail, a chat mention). Every PR you can open has a written diff and
AI review: `diffs.ts` for the planner and tokenizer, one file each under `web/mock/reviews/` for the rest.

## Cloudflare

Workers static assets, no Worker script: `site/dist` as built. `public/_headers` lets only `/demo/` be framed, by the site
itself, and caches hashed assets for a year; `public/_redirects` sends `/install` to `install.sh` on main.

## Next

1. **Agent answers and words.** Per-item answers in Ask your agent instead of "Done: I checked it…"; "in the demo" where
   the window says "on GitHub"; links out show "This is example data"; bundled avatars instead of GitHub's.
2. **Load.** The demo is about 1.2 MB gzipped before a review opens; aim under 700 KB: fewer Shiki grammars and themes,
   no diagram stack. A poster of the opening Inbox holds the frame while it loads.
3. **Hand off's story.** A scripted Merging timeline after Hand off (CI fix → ready → merged), with your agent's notes.
4. **Shots.** A `demo` pass (1280×800, 1024×768, 390×844, light and dark) that writes the posters and the OG image and fails
   on filler diffs, broken avatars or links out.
5. **Deploy.** A Cloudflare project for useinbox.dev, built from main.
