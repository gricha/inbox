# useinbox.dev

The website: one page, with the real Inbox window running in it. The demo at `/demo/` is `web/src` unchanged, talking to the
repo's mock desk (`web/mock/desk.ts`) inside the visitor's tab: `site/demo/desk.ts` answers the window's `fetch` and
`EventSource`, and `site/demo/node/` stands in for the Node builtins the mock's modules import. Each visitor has their own
desk; a reload starts it again. Nothing reaches GitHub.

```bash
npm run site         # the site on Vite at :5190
npm run site:build   # site/dist: static files for Cloudflare
```

## The page

Top to bottom, and nothing else: header (tile, Inbox; GitHub, Install) · headline "One list of what needs you on GitHub." and
one lead paragraph · a line of hints over the demo, each taking the demo to a place (the action stays the visitor's), and
Start over · the demo in an iframe, 1px edge, 12px corners, no fake window chrome, sized to the viewport · Install, one
command (`/install` redirects to the repo's `install.sh`) · three facts (writes only on your click; your agent, your login;
hands off what it can) · a one-line footer.

- **Look.** The app's own Light and Dark tokens and system fonts; the site differs only in scale. No webfont, no analytics, no
  animation beyond Copy → Copied.
- **Phones** (under 720px) get **Open the demo**, which opens `/demo/` full screen in the app's phone layout.
- **Left out on purpose:** features grid, screenshots, themes showcase, video, testimonials, pricing, newsletter, cookie
  banner, docs site (the README is the docs).

## Cloudflare

Workers static assets, no Worker script: `site/dist` as built. `public/_headers` lets only `/demo/` be framed, by the site
itself, and caches hashed assets for a year; `public/_redirects` sends `/install` to `install.sh` on main.

## Next

1. **A demo seed.** The demo shows the screenshot suite's seed today. It needs its own, about ten authored items: the hard
   review (api#4127), your approved PR to hand off, a thread to ask your agent about, an easy low-risk PR, a draft, an issue,
   a question from your agent, a dependency bump sorted into FYI. Every PR you can open needs a written diff (no
   `step_N()` filler). Scrub the internal names (`sentry:`/`seer:` sources, sessions, Gmail and load-test notes), use bundled
   avatars instead of fetching GitHub's, write per-item agent answers instead of "Done: I checked it…", and say "in the demo"
   where the window says "on GitHub". Links out show "This PR is example data."
2. **Load.** The demo is about 1.2 MB gzipped before a review opens; aim under 700 KB: fewer Shiki grammars and themes,
   no diagram stack. A poster of the opening Inbox holds the frame while it loads.
3. **Hand off's story.** A scripted Merging timeline after Hand off (CI fix → ready → merged), with your agent's notes.
4. **Shots.** A `demo` pass (1280×800, 1024×768, 390×844, light and dark) that writes the posters and the OG image and fails
   on filler diffs, broken avatars or links out.
5. **Deploy.** A Cloudflare project for useinbox.dev, built from main.
