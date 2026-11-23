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

The landing page is the demo: the live app fills the first screen, on desktop and on a phone.

- **The stage.** The first screen is petrol, the brand tile's colour. Behind it drifts the raw pile of GitHub notifications
  (review requested, CI failed, dependabot opened…); in front, the live app shows the same work as one sorted list. That
  contrast is the page's one bold idea; everything else stays quiet.
- **The rail** beside the app: the headline "Your GitHub pile, sorted." (Instrument Sans, the app's own face, 700 at 75%
  width), one paragraph, four things to try (each takes the demo to a place; the action stays the visitor's), and Start
  the demo over. Under 1000px the rail's text sits above the app and the things to try below it.
- **Below the stage**, on warm white: Install (one command; `/install` redirects to the repo's `install.sh`), three facts
  (writes only when you click; runs on your agent; hands off what it can), and a footer.
- **Palette:** petrol `#1e3436` and `#365d60`, warm white `#f7f6f2`, ink `#172322`, lichen `#9db8b0` for quiet text on
  petrol, the app's lilac `#c4a7f5` for links and focus. JetBrains Mono only for the pile and the command.
- **Left out on purpose:** features grid, screenshots, themes showcase, video, testimonials, pricing, newsletter, cookie
  banner, analytics, docs site (the README is the docs).

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
