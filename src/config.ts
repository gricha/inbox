// Loads and validates config.toml, and writes the first-run default.
import { parse, TomlError } from "smol-toml";
import {
  BUCKETS,
  type BoardConfig,
  type Bucket,
  type Config,
  type ConfigError,
  type Rule,
  type RuleBucket,
  type SpaceConfig,
} from "./types.ts";
import { compileBoard, type CompiledBoard } from "./rules.ts";
import { DEFAULTS, LEGACY_TABLES, type Settings } from "./settings.ts";

export interface LoadedConfig {
  config: Config;
  boards: CompiledBoard[];
}

type Raw = Record<string, unknown>;

const SORTS = ["waiting", "updated", "newest"] as const;

// Settings (sync interval, bots, prompts, ...) come from settings.json; config.toml holds spaces and boards.
export function parseConfig(
  text: string,
  settings: Settings = DEFAULTS,
): { loaded: LoadedConfig | null; errors: ConfigError[]; warnings: ConfigError[] } {
  let raw: Raw;
  try {
    raw = parse(text);
  } catch (e) {
    const err = e as TomlError;
    return {
      loaded: null,
      errors: [{ path: err.line ? `line ${err.line}` : "toml", message: err.message.split("\n")[0] ?? "" }],
      warnings: [],
    };
  }
  const errors: ConfigError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  const known = (obj: Raw, path: string, keys: string[]) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) err(path ? `${path}.${k}` : k, `unknown key "${k}"`);
  };
  const table = (v: unknown, path: string): Raw => {
    if (v === undefined) return {};
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      err(path, "must be a table");
      return {};
    }
    return v as Raw;
  };
  const str = (v: unknown, path: string, dflt: string): string => {
    if (v === undefined) return dflt;
    if (typeof v !== "string") {
      err(path, "must be a string");
      return dflt;
    }
    return v;
  };
  const num = (v: unknown, path: string, dflt: number): number => {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || Number.isNaN(v)) {
      err(path, "must be a number");
      return dflt;
    }
    return v;
  };
  const strs = (v: unknown, path: string): string[] => {
    if (v === undefined) return [];
    if (typeof v === "string") return [v];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      err(path, "must be a list of strings");
      return [];
    }
    return v as string[];
  };
  const bucket = (v: unknown, path: string, dflt: Bucket): Bucket => {
    if (v === undefined) return dflt;
    if (!BUCKETS.includes(v as Bucket)) {
      err(path, `must be one of ${BUCKETS.join(", ")}`);
      return dflt;
    }
    return v as Bucket;
  };
  const ruleBucket = (v: unknown, path: string): RuleBucket => {
    if (v === "judge") return v;
    if (v !== undefined && !BUCKETS.includes(v as Bucket)) {
      err(path, `must be one of ${BUCKETS.join(", ")}, or judge`);
      return "later";
    }
    return bucket(v, path, "later");
  };

  // Leftovers from before settings.json: their values are ignored, so they don't block the desk.
  const warnings: ConfigError[] = ["poll_seconds", ...LEGACY_TABLES]
    .filter((k) => k in raw)
    .map((k) => ({ path: k, message: `"${k}" moved to Settings (settings.json); delete it here` }));
  known(raw, "", ["spaces", "boards", "poll_seconds", ...LEGACY_TABLES]);

  const spaces: SpaceConfig[] = [];
  const rawSpaces = Array.isArray(raw.spaces) ? raw.spaces : (raw.spaces !== undefined && err("spaces", "must be [[spaces]] tables"), []);
  rawSpaces.forEach((s, i) => {
    const path = `spaces[${i}]`;
    const t = table(s, path);
    known(t, path, ["id", "name", "scope"]);
    const id = str(t.id, `${path}.id`, "");
    if (!id) err(`${path}.id`, "is required");
    else if (spaces.some((x) => x.id === id)) err(`${path}.id`, `duplicate space id "${id}"`);
    spaces.push({ id, name: str(t.name, `${path}.name`, id), scope: str(t.scope, `${path}.scope`, "") });
  });

  const boards: BoardConfig[] = [];
  const compiled: CompiledBoard[] = [];
  const rawBoards = Array.isArray(raw.boards) ? raw.boards : (raw.boards !== undefined && err("boards", "must be [[boards]] tables"), []);
  rawBoards.forEach((b, i) => {
    const path = `boards[${i}]`;
    const t = table(b, path);
    known(t, path, ["id", "space", "name", "query", "queries", "filter", "priority", "rules", "default", "default_why", "sort", "caps"]);
    const id = str(t.id, `${path}.id`, "");
    if (!id) err(`${path}.id`, "is required");
    else if (boards.some((x) => x.id === id)) err(`${path}.id`, `duplicate board id "${id}"`);
    else if (!/^[A-Za-z0-9_-]+$/.test(id)) err(`${path}.id`, "use letters, digits, - and _ only");
    const space = str(t.space, `${path}.space`, spaces[0]?.id ?? "");
    if (!spaces.some((s) => s.id === space)) err(`${path}.space`, `no space with id "${space}"`);
    const queries = [...strs(t.query, `${path}.query`), ...strs(t.queries, `${path}.queries`)];
    if (queries.length === 0) err(`${path}.queries`, "needs at least one GitHub search query");
    const rawRules = t.rules === undefined ? [] : Array.isArray(t.rules) ? t.rules : (err(`${path}.rules`, "must be a list"), []);
    const rules: Rule[] = rawRules.map((r, j) => {
      const rp = `${path}.rules[${j}]`;
      const rt = table(r, rp);
      known(rt, rp, ["when", "bucket", "why", "nocap", "hard"]);
      const when = str(rt.when, `${rp}.when`, "");
      if (!when) err(`${rp}.when`, "is required");
      if (rt.nocap !== undefined && typeof rt.nocap !== "boolean") err(`${rp}.nocap`, "must be true or false");
      if (rt.hard !== undefined && typeof rt.hard !== "boolean") err(`${rp}.hard`, "must be true or false");
      const to = ruleBucket(rt.bucket, `${rp}.bucket`);
      if (rt.hard === true && to === "judge") err(`${rp}.hard`, "a hard rule places the item itself; give it a bucket, not judge");
      return {
        when: when || "false",
        bucket: to,
        why: str(rt.why, `${rp}.why`, ""),
        nocap: rt.nocap === true,
        hard: rt.hard === true,
      };
    });
    const sort = str(t.sort, `${path}.sort`, "waiting");
    if (!(SORTS as readonly string[]).includes(sort)) err(`${path}.sort`, `must be one of ${SORTS.join(", ")}`);
    const caps = table(t.caps, `${path}.caps`);
    known(caps, `${path}.caps`, ["now", "today"]);
    const filter = t.filter === undefined ? undefined : str(t.filter, `${path}.filter`, "");
    const priority = t.priority === undefined ? undefined : str(t.priority, `${path}.priority`, "");
    const board: BoardConfig = {
      id,
      space,
      name: str(t.name, `${path}.name`, id),
      queries,
      filter: filter === "" ? undefined : filter,
      priority: priority === "" ? undefined : priority,
      rules,
      default: bucket(t.default, `${path}.default`, "later"),
      default_why: str(t.default_why, `${path}.default_why`, ""),
      sort: (SORTS as readonly string[]).includes(sort) ? (sort as BoardConfig["sort"]) : "waiting",
      caps:
        t.caps === undefined
          ? undefined
          : {
              now: caps.now === undefined ? undefined : num(caps.now, `${path}.caps.now`, 3),
              today: caps.today === undefined ? undefined : num(caps.today, `${path}.caps.today`, 6),
            },
    };
    const c = compileBoard(board, path);
    errors.push(...c.errors);
    boards.push(board);
    compiled.push(c.board);
  });
  if (boards.length === 0 && errors.length === 0) err("boards", "add at least one [[boards]] table");

  const config: Config = {
    poll_seconds: settings["github.poll_seconds"],
    signals: {
      close_collaborator_min: settings["github.close_collaborator_min"],
      bots: settings["github.bots"],
      my_repos: settings["github.my_repos"],
    },
    notify: { enabled: settings["notify.enabled"], quiet: settings["notify.quiet"] },
    handoff: { prompt: settings["handoff.prompt"], mine: settings["handoff.mine"], issue: settings["handoff.issue"] },
    spaces,
    boards,
  };
  return { loaded: errors.length ? null : { config, boards: compiled }, errors, warnings };
}

const toml = (s: string) => JSON.stringify(s);

// First-run config: one space per work org (the orgs most of your open items live in), plus Personal for the rest.
export function defaultConfigText(opts: { workOrgs: string[] }): string {
  const orgs = opts.workOrgs;
  const personalScope = orgs.map((o) => `-org:${o}`).join(" ");
  const out: string[] = [
    `# Review Desk config. Edit it on the Rules page (⌘S saves) or here; the server reloads on save.`,
    `# Each [[boards]] table feeds the queue: GitHub searches (the space scope is appended), an optional filter,`,
    `# and rules. The first rule whose \`when\` is true puts the item in a bucket: now, today, later, fyi, hide.`,
    `# Claude then sorts every item by your policy (Settings → Policy), with the rule's bucket as its hint; a rule with`,
    `# \`hard = true\` is final: Claude doesn't sort what it matches, and neither quiet days nor caps move it.`,
    `# \`caps\` limit Now and Today; overflow moves down a bucket with a note. Pinned and \`nocap\` items don't count, and nor do`,
    `# your PRs in flight that need you. Caps apply after Claude, so give every board one: a board without caps can fill Now.`,
    `# Expressions: && || ! == != < <= > >= in matches ( ) and len() lower() contains() startswith() any().`,
    `# Fields (me.requested_direct, author.close, pr.ci, ...) are listed on the Rules page and by \`desk fields\`.`,
    `# Within a bucket, cards sort by rule order (earlier rules first), then \`priority\`, then \`sort\`.`,
    `# \`why\` texts can include fields: "{author.login} asked you".`,
    `# Sync interval, bots, notifications and hand-off prompts are on the Settings page (settings.json).`,
  ];
  const spaces: { id: string; name: string; scope: string }[] = orgs.map((o) => ({ id: o, name: o, scope: `org:${o}` }));
  spaces.push({ id: "personal", name: "Personal", scope: personalScope });
  for (const s of spaces) out.push(``, `[[spaces]]`, `id = ${toml(s.id)}`, `name = ${toml(s.name)}`, `scope = ${toml(s.scope)}`);

  for (const s of spaces) {
    const work = s.id !== "personal";
    out.push(
      ``,
      `# ── ${s.name} ──`,
      ``,
      `[[boards]]`,
      `id = ${toml(`${s.id}-review`)}`,
      `space = ${toml(s.id)}`,
      `name = "PRs to review"`,
      `queries = [`,
      `  "is:pr is:open archived:false review-requested:@me",`,
      `  "is:pr is:open archived:false reviewed-by:@me -author:@me",`,
      `]`,
      `filter = "!item.draft && (me.requested || me.pushed_since_review)"`,
      `priority = "author.engaged_90d"   # within a bucket: people you work with most first, then longest waiting`,
      `sort = "waiting"`,
      `caps = { now = 3, today = 6 }`,
      `default = "later"`,
      `default_why = "review requested"`,
      `rules = [`,
      `  { when = "me.requested_direct && !me.requested_by_bot", bucket = "now", why = "{me.requested_by} asked you directly", hard = true },`,
      `  { when = "!me.requested && me.review_state == 'changes_requested'", bucket = "today", why = "new commits after you requested changes" },`,
      `  { when = "!me.requested", bucket = "later", why = "new commits since your review" },`,
      `  { when = "author.close && !me.requested_codeowner", bucket = "today", why = "close collaborator: you engaged with {author.engaged_90d} of their PRs in 90 days" },`,
      `  { when = "repo.mine", bucket = "today", why = "your repo" },`,
      `  { when = "author.bot", bucket = "fyi", why = "bot PR" },`,
      `  { when = "me.requested_by_bot", bucket = "later", why = "added by {me.requested_by} (bot)" },`,
      `  { when = "me.requested_codeowner && !me.requested_direct", bucket = "fyi", why = "CODEOWNERS ping to @{me.requested_team}" },`,
      `]`,
      ``,
      `[[boards]]`,
      `id = ${toml(`${s.id}-mine`)}`,
      `space = ${toml(s.id)}`,
      `name = "My PRs"`,
      `queries = ["is:pr is:open archived:false author:@me"]`,
      `sort = "updated"`,
      `caps = { now = 3, today = 6 }`,
      `default = "fyi"`,
      `default_why = "waiting on reviewers"`,
      `rules = [`,
      `  { when = "item.draft", bucket = "later", why = "draft" },`,
      `  { when = "pr.review == 'changes_requested'", bucket = "now", why = "changes requested", nocap = true },`,
      `  { when = "pr.ci == 'red'", bucket = "now", why = "CI failing" },`,
      `  { when = "pr.mergeable == 'conflict'", bucket = "today", why = "merge conflict" },`,
      `  { when = "me.new_activity", bucket = "today", why = "new comments or reviews" },`,
      `  { when = "pr.review == 'approved' && pr.ci == 'green'", bucket = "today", why = "approved and green: ready to merge" },`,
      `  { when = "pr.unresolved_threads > 0", bucket = "later", why = "unresolved threads: {pr.unresolved_threads}" },`,
      `  { when = "item.activity_hours > 72", bucket = "later", why = "quiet for 3+ days: nudge a reviewer?" },`,
      `]`,
      ``,
      `[[boards]]`,
      `id = ${toml(`${s.id}-mentions`)}`,
      `space = ${toml(s.id)}`,
      `name = ${toml(work ? "Mentions & assigned" : "Issues & mentions")}`,
      `queries = [`,
      `  "is:open archived:false mentions:@me -author:@me",`,
      `  "is:open archived:false assignee:@me -author:@me",`,
      ...(work ? [] : [`  "is:issue is:open archived:false author:@me",`]),
      `]`,
      `filter = "item.updated_hours < 2160 && (item.activity_hours < 336 || me.assignee)"`,
      `sort = "updated"`,
      `caps = { now = 3, today = 6 }`,
      `default = "fyi"`,
      `default_why = "mentions you"`,
      `rules = [`,
      `  { when = "me.new_activity", bucket = "today", why = "new replies since you last acted" },`,
      `  { when = "!me.commented && !me.author && item.activity_hours < 72", bucket = "today", why = "you were mentioned and haven't replied" },`,
      `  { when = "me.assignee", bucket = "later", why = "assigned to you" },`,
      ...(work ? [] : [`  { when = "me.author", bucket = "fyi", why = "your issue" },`]),
      `]`,
    );
    if (work) {
      out.push(
        ``,
        `# PRs from people you work with most, where nobody asked you. {close_authors} expands to your top collaborators.`,
        `[[boards]]`,
        `id = ${toml(`${s.id}-collaborators`)}`,
        `space = ${toml(s.id)}`,
        `name = "Close collaborators"`,
        `queries = ["is:pr is:open archived:false -is:draft -author:@me -review-requested:@me {close_authors}"]`,
        `sort = "updated"`,
        `caps = { now = 3, today = 6 }`,
        `default = "fyi"`,
        `default_why = "{author.login}: you engaged with {author.engaged_90d} of their PRs in 90 days"`,
        `rules = [`,
        `  { when = "item.created_hours < 24", bucket = "later", why = "new from {author.login}" },`,
        `]`,
      );
    }
  }
  return out.join("\n") + "\n";
}
