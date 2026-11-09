// The desk's permalinks: inbox://item/<owner>/<repo>/<number> for a PR or an issue, and inbox://inbox, inbox://blocked,
// inbox://fyi, inbox://merging and inbox://archive for the pages. Copy link copies them, the desktop app opens them, and
// every ref reads them, as it does the desk's own http links (http://localhost:47823/#/review/<id>).
import { Result } from "effect";

// Each page's name in a link, its words, and its route in the window (web/src/view.ts).
const PAGES = {
  inbox: { name: "Inbox", hash: "#/" },
  blocked: { name: "Blocked", hash: "#/blocked" },
  fyi: { name: "FYI", hash: "#/later" },
  merging: { name: "Merging", hash: "#/inflight" },
  archive: { name: "Archive", hash: "#/archive" },
} as const;
type Page = keyof typeof PAGES;
export type Place = { page: Page } | { item: string };

const isPage = (s: string): s is Page => Object.hasOwn(PAGES, s);
const GITHUB_ID = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const DESK_LINK = /^(?:inbox:|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/#]|$))/i;
const decode = (s: string): string | null => {
  const r = Result.try({ try: () => decodeURIComponent(s), catch: () => null });
  return Result.isSuccess(r) && r.success ? r.success : null;
};

export function permalink(p: Place): string {
  if ("page" in p) return `inbox://${p.page}`;
  const m = GITHUB_ID.exec(p.item);
  return m ? `inbox://item/${m[1]!}/${m[2]!}/${m[3]!}` : `inbox://item/${encodeURIComponent(p.item)}`;
}

// The window's route to it: an item's opens a PR's review, or an issue in place on its page.
export const hashOf = (p: Place): string => ("page" in p ? PAGES[p.page].hash : `#/item/${encodeURIComponent(p.item)}`);

// What a link names: an inbox:// permalink, or the desk's own http link (localhost, any port); null for anything else.
export function placeOf(link: string): Place | null {
  const s = link.trim();
  const app = /^inbox:\/\/([^?#]*?)\/?$/i.exec(s);
  if (app) {
    const path = app[1]!;
    const lower = path.toLowerCase();
    if (isPage(lower)) return { page: lower };
    const gh = /^item\/([\w.-]+)\/([\w.-]+)\/(\d+)$/i.exec(path);
    if (gh) return { item: `${gh[1]!}/${gh[2]!}#${gh[3]!}` };
    // Another source's id has its "source:" (a bare id is GitHub's), in one piece.
    const other = /^item\/([^/]+)$/i.exec(path)?.[1];
    const id = other ? decode(other) : null;
    return id?.includes(":") ? { item: id } : null;
  }
  const web = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?(?:#(.*))?$/i.exec(s);
  if (!web) return null;
  const route = web[1] ?? "";
  if (route === "" || route === "/") return { page: "inbox" };
  const page = (Object.keys(PAGES) as Page[]).find((p) => PAGES[p].hash === `#${route}`);
  if (page) return { page };
  const item = /^\/(?:review|item)\/(.+)$/.exec(route)?.[1];
  const id = item ? decode(item) : null;
  return id ? { item: id } : null;
}

// A ref that's a desk link: the id of the item it names, or the words refusing one that names none (a page's, or junk);
// null for any other ref, which the connectors read.
export function linkRef(ref: string): { id: string } | { refused: string } | null {
  const s = ref.trim();
  if (!DESK_LINK.test(s)) return null;
  const p = placeOf(s);
  if (p && "item" in p) return { id: p.item };
  if (p) return { refused: `"${s}" is the ${PAGES[p.page].name} page's link, not an item's: give a PR's or an issue's` };
  return { refused: `can't read "${s}"; an item's link is inbox://item/owner/repo/123` };
}
