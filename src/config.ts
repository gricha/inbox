// Loads and validates config.toml, and writes the first-run default.
import { Result } from "effect";
import { parse, TomlError } from "smol-toml";
import {
  BUCKETS,
  RULE_WEIGHT,
  type BoardConfig,
  type Bucket,
  type BuiltInRules,
  type Config,
  type ConfigError,
  type Rule,
  type RuleBucket,
  type SpaceConfig,
} from "./types.ts";
import { compileBoard, type CompiledBoard } from "./rules.ts";
import { field, isRecord, oneOf, strings } from "./narrow.ts";
import { DEFAULTS, LEGACY_TABLES, type Settings } from "./settings.ts";
import { GITHUB_RULES } from "./connectors/github-rules.ts";

export interface LoadedConfig {
  config: Config;
  boards: CompiledBoard[];
}

type Raw = Record<string, unknown>;

// A connector the desk runs, as config.toml sees it: its id (a board's `source`) and the rules its boards may name.
export interface Source {
  id: string;
  rules?: Readonly<Record<string, BuiltInRules>>;
}

const GITHUB: Source = { id: "github", rules: GITHUB_RULES };

// A rule as it's placed: where it was written to go is done with.
function placed(r: Rule): Rule {
  const out = { ...r };
  delete out.after;
  return out;
}

// A board's rules in order: yours first, then the plugin's, each but those switched off, or yours in its place (an own rule
// with its id), followed by yours placed `after` it.
export function resolveRules(set: BuiltInRules, off: readonly string[], own: readonly Rule[]): Rule[] {
  const out = own.filter((r) => r.id === undefined && r.after === undefined).map(placed);
  for (const b of set.rules) {
    const mine = own.find((r) => r.id === b.id);
    if (mine) out.push(placed(mine));
    else if (!off.includes(b.id)) out.push({ ...b });
    out.push(...own.filter((r) => r.after === b.id).map(placed));
  }
  return out;
}

const SORTS = ["waiting", "updated", "newest"] as const;

// smol-toml says which line; a document nested deeper than the stack goes (a RangeError) has none.
function tomlError(e: unknown): ConfigError {
  const line = e instanceof TomlError ? e.line : undefined;
  return { path: line ? `line ${line}` : "toml", message: (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "" };
}

// Settings (sync interval, bots, prompts, ...) come from settings.json; config.toml holds spaces and boards.
export function parseConfig(
  text: string,
  settings: Settings = DEFAULTS,
  sources: readonly Source[] = [GITHUB], // the connectors the desk runs: a board's `source` names one
): { loaded: LoadedConfig | null; errors: ConfigError[]; warnings: ConfigError[] } {
  const parsed = Result.try({ try: (): Raw => parse(text), catch: tomlError });
  if (Result.isFailure(parsed)) return { loaded: null, errors: [parsed.failure], warnings: [] };
  const raw = parsed.success;
  const errors: ConfigError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  const known = (obj: Raw, path: string, keys: string[]) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) err(path ? `${path}.${k}` : k, `unknown key "${k}"`);
  };
  const table = (v: unknown, path: string): Raw => {
    if (v === undefined) return {};
    if (!isRecord(v)) {
      err(path, "must be a table");
      return {};
    }
    return v;
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
    const list = strings(v);
    if (!list) {
      err(path, "must be a list of strings");
      return [];
    }
    return list;
  };
  const bucket = (v: unknown, path: string, dflt: Bucket): Bucket => {
    if (v === undefined) return dflt;
    const b = oneOf(BUCKETS, v);
    if (b === undefined) {
      err(path, `must be one of ${BUCKETS.join(", ")}`);
      return dflt;
    }
    return b;
  };
  const ruleBucket = (v: unknown, path: string): RuleBucket => {
    if (v === "judge") return v;
    if (v !== undefined && oneOf(BUCKETS, v) === undefined) {
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
    known(t, path, [
      "id",
      "space",
      "name",
      "source",
      "query",
      "queries",
      "filter",
      "priority",
      "rules",
      "builtin",
      "off",
      "default",
      "default_why",
      "sort",
      "caps",
    ]);
    const id = str(t.id, `${path}.id`, "");
    if (!id) err(`${path}.id`, "is required");
    else if (boards.some((x) => x.id === id)) err(`${path}.id`, `duplicate board id "${id}"`);
    else if (!/^[A-Za-z0-9_-]+$/.test(id)) err(`${path}.id`, "use letters, digits, - and _ only");
    const space = str(t.space, `${path}.space`, spaces[0]?.id ?? "");
    if (!spaces.some((s) => s.id === space)) err(`${path}.space`, `no space with id "${space}"`);
    const source = t.source === undefined ? undefined : str(t.source, `${path}.source`, "github");
    if (source !== undefined && !sources.some((c) => c.id === source))
      err(`${path}.source`, `must be one of ${sources.map((c) => c.id).join(", ")}`);
    const queries = [...strs(t.query, `${path}.query`), ...strs(t.queries, `${path}.queries`)];
    if (queries.length === 0 && (source ?? "github") === "github") err(`${path}.queries`, "needs at least one GitHub search query");
    const builtin = t.builtin === undefined ? undefined : str(t.builtin, `${path}.builtin`, "");
    const sets = sources.find((c) => c.id === (source ?? "github"))?.rules ?? {};
    const set = builtin === undefined ? undefined : sets[builtin];
    if (builtin !== undefined && !set)
      err(
        `${path}.builtin`,
        Object.keys(sets).length ? `must be one of ${Object.keys(sets).join(", ")}` : `${source ?? "github"} comes with no rules`,
      );
    const has = (ref: string) => set?.rules.some((r) => r.id === ref) === true;
    const off = strs(t.off, `${path}.off`);
    off.forEach((ref, k) => {
      if (set && !has(ref)) err(`${path}.off[${k}]`, `${builtin} has no rule "${ref}"`);
    });
    if (off.length && builtin === undefined) err(`${path}.off`, "switches off built-in rules: name them with builtin");
    const rawRules = t.rules === undefined ? [] : Array.isArray(t.rules) ? t.rules : (err(`${path}.rules`, "must be a list"), []);
    const own: Rule[] = rawRules.map((r, j) => {
      const rp = `${path}.rules[${j}]`;
      const rt = table(r, rp);
      known(rt, rp, ["when", "bucket", "why", "nocap", "hard", "final", "weight", "id", "after"]);
      const when = str(rt.when, `${rp}.when`, "");
      if (!when) err(`${rp}.when`, "is required");
      if (rt.nocap !== undefined && typeof rt.nocap !== "boolean") err(`${rp}.nocap`, "must be true or false");
      if (rt.hard !== undefined && typeof rt.hard !== "boolean") err(`${rp}.hard`, "must be true or false");
      if (rt.final !== undefined && typeof rt.final !== "boolean") err(`${rp}.final`, "must be true or false");
      const weight = rt.weight === undefined ? undefined : num(rt.weight, `${rp}.weight`, RULE_WEIGHT);
      if (weight !== undefined && (weight < 0 || weight > 10)) err(`${rp}.weight`, "must be from 0 to 10");
      const to = ruleBucket(rt.bucket, `${rp}.bucket`);
      if (rt.hard === true && to === "judge") err(`${rp}.hard`, "a hard rule places the item itself; give it a bucket, not judge");
      if (rt.final === true && to === "judge") err(`${rp}.final`, "a final rule places the item itself; give it a bucket, not judge");
      const ref = rt.id === undefined ? undefined : str(rt.id, `${rp}.id`, "");
      const after = rt.after === undefined ? undefined : str(rt.after, `${rp}.after`, "");
      for (const [key, v] of [
        ["id", ref],
        ["after", after],
      ] as const) {
        if (v === undefined) continue;
        if (builtin === undefined) err(`${rp}.${key}`, "names a built-in rule: name the board's with builtin");
        else if (set && !has(v)) err(`${rp}.${key}`, `${builtin} has no rule "${v}"`);
      }
      if (ref !== undefined && after !== undefined) err(`${rp}.after`, "a rule with an id stands in that rule's place; drop after");
      if (ref !== undefined && off.includes(ref)) err(`${rp}.id`, `"${ref}" is switched off in off; drop one of them`);
      const rule: Rule = {
        when: when || "false",
        bucket: to,
        why: str(rt.why, `${rp}.why`, ""),
        nocap: rt.nocap === true,
        hard: rt.hard === true,
        final: rt.final === true,
      };
      if (weight !== undefined) rule.weight = weight;
      if (builtin !== undefined) rule.own = j;
      if (ref !== undefined) rule.id = ref;
      if (after !== undefined) rule.after = after;
      return rule;
    });
    own.forEach((r, j) => {
      if (r.id !== undefined && own.findIndex((x) => x.id === r.id) < j)
        err(`${path}.rules[${j}].id`, `another rule of yours replaces "${r.id}"`);
    });
    const rules = set ? resolveRules(set, off, own) : own.map(placed);
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
      ...(source !== undefined && { source }),
      queries,
      ...(filter && { filter }),
      ...(priority && { priority }),
      rules,
      ...(builtin !== undefined && { builtin }),
      ...(off.length > 0 && { off }),
      default: bucket(t.default, `${path}.default`, "later"),
      default_why: str(t.default_why, `${path}.default_why`, ""),
      sort: oneOf(SORTS, sort) ?? "waiting",
      ...(t.caps !== undefined && {
        caps: {
          ...(caps.now !== undefined && { now: num(caps.now, `${path}.caps.now`, 3) }),
          ...(caps.today !== undefined && { today: num(caps.today, `${path}.caps.today`, 6) }),
        },
      }),
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
      my_names: settings["github.my_names"],
    },
    handoff: { prompt: settings["handoff.prompt"], mine: settings["handoff.mine"], issue: settings["handoff.issue"] },
    spaces,
    boards,
  };
  return { loaded: errors.length ? null : { config, boards: compiled }, errors, warnings };
}

const toml = (s: string) => JSON.stringify(s);

// Configs written before hard rules existed exempted a review asked of you by name from caps (nocap) instead: that rule,
// and only as the first-run config wrote it, becomes hard. Null when there's nothing to change.
export function migrateHard(text: string): string | null {
  const rule =
    /^(\s*\{ when = "me\.requested_direct && !me\.requested_by_bot", bucket = "now", why = "[^"\n]*")(, nocap = true)?( \},?)$/gm;
  const next = text.replaceAll(rule, (_, head: string, _nocap: string | undefined, tail: string) => `${head}, hard = true${tail}`);
  return next === text ? null : next;
}

const BOT_ASK = `{ when = "me.requested_direct", bucket = "today", why = "asked you by name (added by {me.requested_by})", hard = true }`;

// A review a bot asked of you by name (Junior adds them for people) gets a hard rule of its own, right after the hard rule
// for a person's ask, as the first-run config writes both. Null when there's nothing to change.
export function migrateBotAsk(text: string): string | null {
  if (text.includes(BOT_ASK)) return null;
  const rule = /^([ \t]*)(\{ when = "me\.requested_direct && !me\.requested_by_bot", bucket = "now", why = "[^"\n]*", hard = true \}),?$/gm;
  const next = text.replaceAll(rule, (_, indent: string, head: string) => `${indent}${head},\n${indent}${BOT_ASK},`);
  return next === text ? null : next;
}

// A bot's PR opened for you assigns you (docs/api.md → Opened for you): the Mentions board's search, so no extra one.
const MY_PRS = [
  `queries = ["is:pr is:open archived:false author:@me", "is:open archived:false assignee:@me -author:@me"]`,
  `filter = "me.author"`,
];

// The first-run My PRs board lists a bot's PR opened for you too, only as written and with no filter of yours. Null if absent.
export function migrateOnBehalf(text: string): string | null {
  const next = text
    .split(/(?=^\[\[boards\]\])/m)
    .map((table) =>
      /^filter\s*=/m.test(table)
        ? table
        : table.replace(/^([ \t]*)queries = \["is:pr is:open archived:false author:@me"\][ \t]*$/m, (_, indent: string) =>
            MY_PRS.map((l) => indent + l).join("\n"),
          ),
    )
    .join("");
  return next === text ? null : next;
}

const FRESH_DRAFT = `{ when = "item.draft && item.updated_hours < 336", bucket = "today", why = "your draft: finish it", hard = true`;
const WAITS_REVIEW = `{ when = "len(pr.waiting_on) > 0 && !me.owes_reply && pr.ci != 'red'", bucket = "blocked", why = "{pr.waits}", final = true }`;
const WAITS_NO_CONFLICT = `{ when = "len(pr.waiting_on) > 0 && !me.owes_reply && pr.ci != 'red' && pr.mergeable != 'conflict'", bucket = "blocked", why = "{pr.waits}", final = true }`;

// The first-run rule for your PRs waiting on reviewers left one with a merge conflict to whatever rule came next (unresolved
// threads: Later, away from the PRs it blocks); only as written, it becomes today's. Null if absent.
export function migrateWaitsConflict(text: string): string | null {
  const next = text.replaceAll(WAITS_NO_CONFLICT, WAITS_REVIEW);
  return next === text ? null : next;
}

// The old first-run rule sending all your drafts to later, only as written, becomes today's two draft rules; null if absent.
export function migrateDrafts(text: string): string | null {
  const next = text.replaceAll(
    /^([ \t]*)\{ when = "item\.draft", bucket = "later", why = "draft" \},$/gm,
    (_, indent: string) =>
      `${indent}${FRESH_DRAFT} },\n${indent}{ when = "item.draft", bucket = "later", why = "draft, quiet for 2+ weeks" },`,
  );
  return next === text ? null : next;
}

// A merge conflict alone isn't yours (the coordinator rebases a PR that's otherwise ready): the old first-run rule putting
// one on your desk goes, only as written. Null if absent.
export function migrateConflict(text: string): string | null {
  const next = text.replaceAll(
    /^[ \t]*\{ when = "pr\.mergeable == 'conflict'", bucket = "today", why = "merge conflict" \},?[ \t]*\r?\n/gm,
    "",
  );
  return next === text ? null : next;
}

const terms = (scope: string) => scope.toLowerCase().split(/\s+/).filter(Boolean);
const names = (t: string) => /^(org|user|repo):/.test(t);

// The space that takes every org no other names: one that names none itself, only leaving some out (Personal's
// `-org:acme -org:getsentry`), or an empty scope.
export function catchAllOf(spaces: readonly { name: string; scope: string }[]): string | null {
  return spaces.find((s) => !terms(s.scope).some(names))?.name ?? null;
}

// The space an org's items land in: the first that names it (org:acme), else the catch-all unless it leaves the org out;
// null when none takes it.
export function spaceOf(org: string, spaces: readonly { name: string; scope: string }[]): string | null {
  const o = org.toLowerCase();
  const named = spaces.find((s) => terms(s.scope).some((t) => t === `org:${o}` || t === `user:${o}` || t.startsWith(`repo:${o}/`)));
  if (named) return named.name;
  const rest = spaces.find((s) => {
    const t = terms(s.scope);
    return !t.some(names) && !t.includes(`-org:${o}`) && !t.includes(`-user:${o}`);
  });
  return rest?.name ?? null;
}

// A rule as the first-run config writes one: on one line, in this order of keys.
function ruleToml(r: Rule): string {
  const keys = [
    `when = ${toml(r.when)}`,
    `bucket = ${toml(r.bucket)}`,
    `why = ${toml(r.why ?? "")}`,
    r.nocap && "nocap = true",
    r.hard && "hard = true",
    r.final && "final = true",
    r.weight !== undefined && `weight = ${r.weight}`,
  ];
  return `{ ${keys.filter(Boolean).join(", ")} }`;
}

// A board's built-in rules: the line naming them, or (expanded) written out as rules of yours, as configs before them had them.
function builtinLines(set: string, expanded: boolean): string[] {
  const rules = GITHUB_RULES[set]!.rules;
  if (!expanded) return [`builtin = ${toml(set)}`];
  return [`rules = [`, ...rules.map((r) => `  ${ruleToml(r)},`), `]`];
}

// First-run config: one space per work org (the orgs most of your open items live in), plus Personal for the rest. Each board
// names GitHub's rules for it (`builtin`); expanded writes them out instead, as the first-run config did before.
export function defaultConfigText(opts: { workOrgs: string[]; expanded?: boolean }): string {
  const orgs = opts.workOrgs;
  const expanded = opts.expanded === true;
  const personalScope = orgs.map((o) => `-org:${o}`).join(" ");
  const out: string[] = [
    `# Inbox config. Edit it in Settings → GitHub → Searches and rules, or here; the desk reloads it on save.`,
    `# Each [[boards]] table feeds your desk: GitHub searches (the space scope is appended), an optional filter,`,
    `# and rules. The first rule whose \`when\` is true puts the item in a bucket: now, today, blocked, later, fyi, hide.`,
    `# \`builtin\` names the rules GitHub comes with for the board (review, mine, mentions, issues, collaborators): they come`,
    `# after yours and stay as the desk has them, so a release that improves one reaches you. Settings lists them with their ids.`,
    `#   off = ["bot-pr"]                                      switches built-in rules off`,
    `#   { id = "bot-pr", when = "...", bucket = "fyi", ... }   in rules: yours, in that built-in rule's place`,
    `#   { after = "bot-pr", when = "...", bucket = "fyi" }     in rules: yours, right after it (the others in rules go first)`,
    `# Claude then sorts every item, weighing every rule that matches it: \`weight\` (0 to 10, ${RULE_WEIGHT} unless set) says how much`,
    `# one counts. The first matching rule's bucket is where the item sits until Claude answers.`,
    `# A rule with \`hard = true\` is a floor: what it matches never sorts below its bucket (Today for a Now rule), whatever`,
    `# Claude, quiet days or caps say.`,
    `# A rule with \`final = true\` isn't re-sorted by Claude: what it matches stays in its bucket (your pin still lifts it).`,
    `# \`blocked\`: it can't move until something else happens: a PR it needs merging first (pr.blocked: its description says`,
    `# "Requires \u2026", or it's stacked on it), or reviewers you asked. Only rules fill it: Claude never answers blocked. The`,
    `# Blocked page lists it, and a hand-back of a PR another PR blocks waits there until that PR merges.`,
    `# \`caps\` limit Now and Today; overflow moves down a bucket with a note. Pinned and \`nocap\` items don't count, and nor do`,
    `# your PRs in Merging. Caps apply after Claude, so give every board one: a board without caps can fill Now.`,
    `# Expressions: && || ! == != < <= > >= in matches ( ) and len() lower() contains() startswith() any().`,
    `# Fields (me.requested_direct, author.close, pr.ci, ...) are listed beside the editor in Searches and rules and by \`desk fields\`.`,
    `# Within a bucket, cards sort by rule order (earlier rules first), then \`priority\`, then \`sort\`.`,
    `# \`why\` texts can include fields: "{author.login} asked you".`,
    `# Sync interval, bots, notifications and agents' prompts are in Settings (settings.json).`,
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
      ...builtinLines("review", expanded),
      ``,
      `[[boards]]`,
      `id = ${toml(`${s.id}-mine`)}`,
      `space = ${toml(s.id)}`,
      `name = "My PRs"`,
      ...MY_PRS,
      `sort = "updated"`,
      `caps = { now = 3, today = 6 }`,
      `default = "later"`,
      `default_why = "waiting on reviewers"`,
      ...builtinLines("mine", expanded),
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
      ...builtinLines(work ? "mentions" : "issues", expanded),
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
        ...builtinLines("collaborators", expanded),
      );
    }
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- built-in rules in a config written before them

const plain = (r: Rule) => JSON.stringify([r.when, r.bucket, r.why ?? "", !!r.nocap, !!r.hard, !!r.final]);

// The longest common subsequence of two lists of keys, as index pairs in order.
function common(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const len = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) len[i]![j] = a[i] === b[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

// What a board's own rules become against a set: each dropped (it is the set's), in a built-in's place (`id`: one that
// differs from it only in some keys, between the same neighbours), or after one (`after`), or first; and what's off.
interface Plan {
  set: string;
  off: string[];
  own: { at: number; id?: string; after?: string }[];
}

function planFor(rules: readonly Rule[], sets: Readonly<Record<string, BuiltInRules>>): Plan | null {
  let best: { set: string; pairs: [number, number][] } | null = null;
  for (const [name, set] of Object.entries(sets)) {
    const pairs = common(rules.map(plain), set.rules.map(plain));
    const better =
      !best || pairs.length > best.pairs.length || (pairs.length === best.pairs.length && set.rules.length < sets[best.set]!.rules.length);
    if (pairs.length && pairs.length * 2 >= set.rules.length && better) best = { set: name, pairs };
  }
  if (!best) return null;
  const set = sets[best.set]!.rules;
  const kept = new Map<number, string>(); // own index → the built-in it is (dropped) or stands in for (id)
  const ids = new Map<number, string>();
  const anchors: [number, number][] = [[-1, -1], ...best.pairs, [rules.length, set.length]];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [o0, b0] = anchors[k]!;
    const [o1, b1] = anchors[k + 1]!;
    if (k > 0) kept.set(o0, set[b0]!.id);
    let from = b0 + 1;
    for (let o = o0 + 1; o < o1; o++) {
      const r = rules[o]!;
      for (let b = from; b < b1; b++) {
        if (set[b]!.when !== r.when && set[b]!.why !== (r.why ?? "")) continue;
        ids.set(o, set[b]!.id);
        from = b + 1;
        break;
      }
    }
  }
  const used = new Set([...kept.values(), ...ids.values()]);
  const own: Plan["own"] = [];
  let anchor: string | undefined;
  rules.forEach((_, at) => {
    const id = kept.get(at) ?? ids.get(at);
    if (kept.has(at)) anchor = id;
    else if (id) {
      own.push({ at, id });
      anchor = id;
    } else own.push({ at, ...(anchor !== undefined && { after: anchor }) });
  });
  return { set: best.set, off: set.filter((r) => !used.has(r.id)).map((r) => r.id), own };
}

// The span of a `rules = [ … ]` array in a board's table: where its line starts, where its last line ends, each element's
// span, and the comments in it. Null when there's none, or it's not one this can read (the board's rules as [[boards.rules]]).
function rulesArray(table: string): { start: number; end: number; elements: [number, number][]; comments: string[] } | null {
  const head = /^[ \t]*rules[ \t]*=[ \t]*\[/m.exec(table);
  if (!head) return null;
  const elements: [number, number][] = [];
  const comments: string[] = [];
  let depth = 0;
  let open = -1;
  for (let i = head.index + head[0].length - 1; i < table.length; i++) {
    const ch = table[i]!;
    if (ch === '"' || ch === "'") {
      for (i++; i < table.length && table[i] !== ch; i++) if (ch === '"' && table[i] === "\\") i++;
    } else if (ch === "#") {
      const eol = table.indexOf("\n", i);
      comments.push(table.slice(i, eol < 0 ? undefined : eol).trimEnd());
      i = eol < 0 ? table.length : eol - 1;
    } else if (ch === "[" || ch === "{") {
      if (depth === 1 && ch === "{") open = i;
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 1 && ch === "}") elements.push([open, i + 1]);
      if (depth === 0) {
        const eol = table.indexOf("\n", i);
        const rest = table.slice(i + 1, eol < 0 ? undefined : eol);
        if (rest.trim().startsWith("#")) comments.push(rest.trim());
        else if (rest.trim()) return null;
        return { start: head.index, end: eol < 0 ? table.length : eol, elements, comments };
      }
    }
  }
  return null;
}

// Splits config.toml into what comes before the first [[boards]] and one piece per board; null when that isn't one to a board.
function boardTables(text: string, count: number): string[] | null {
  const parts = text.split(/(?=^\[\[boards\]\][ \t]*(?:#[^\n]*)?\r?$)/m);
  if (!(parts[0] ?? "").startsWith("[[boards]]")) return parts.length === count + 1 ? parts : null;
  return parts.length === count ? ["", ...parts] : null;
}

// Where a board's own keys end: its next table, a sub-table or another kind's.
const tableEnd = (part: string) => {
  const next = /^[ \t]*\[\[?[ \t]*[A-Za-z_"']/m.exec(part.slice(part.indexOf("\n") + 1));
  return next ? part.indexOf("\n") + 1 + next.index : part.length;
};

// A config written before built-in rules had GitHub's written out on each board: a board whose rules are mostly one set's
// names that set (`builtin`), keeps the rules of yours (`id` where one stands in a built-in's place, `after` where it follows
// one) and switches off what it didn't have (`off`). Only where every board's rules come out exactly as they were. Null if
// nothing changes.
export function migrateBuiltIns(text: string, sources: readonly Source[] = [GITHUB]): string | null {
  const before = parseConfig(text, DEFAULTS, sources);
  if (!before.loaded) return null;
  const boards = before.loaded.config.boards;
  const parts = boardTables(text, boards.length);
  if (!parts) return null;
  let changed = false;
  boards.forEach((b, i) => {
    const sets = sources.find((c) => c.id === (b.source ?? "github"))?.rules;
    const part = parts[i + 1]!;
    if (b.builtin !== undefined || !sets || !b.rules.length) return;
    const own = part.slice(0, tableEnd(part));
    const arr = rulesArray(own);
    const plan = planFor(b.rules, sets);
    if (!arr || !plan || arr.elements.length !== b.rules.length) return;
    const indent = /^[ \t]*/.exec(own.slice(arr.start))![0];
    const lines = [
      ...arr.comments.map((c) => indent + c),
      `${indent}builtin = ${toml(plan.set)}`,
      ...(plan.off.length ? [`${indent}off = [${plan.off.map(toml).join(", ")}]`] : []),
    ];
    if (plan.own.length) {
      lines.push(`${indent}rules = [`);
      for (const o of plan.own) {
        const [s, e] = arr.elements[o.at]!;
        const key = o.id !== undefined ? `id = ${toml(o.id)}` : o.after !== undefined ? `after = ${toml(o.after)}` : "";
        const el = own.slice(s, e);
        lines.push(`${indent}  ${key ? `{ ${key}, ${el.slice(1).trimStart()}` : el},`);
      }
      lines.push(`${indent}]`);
    }
    parts[i + 1] = own.slice(0, arr.start) + lines.join("\n") + own.slice(arr.end) + part.slice(own.length);
    changed = true;
  });
  if (!changed) return null;
  const next = parts.join("");
  const after = parseConfig(next, DEFAULTS, sources).loaded;
  const same = (b: BoardConfig) => {
    const { builtin: _builtin, off: _off, ...rest } = b;
    return JSON.stringify({ ...rest, rules: b.rules.map(plain) });
  };
  if (!after || after.config.boards.length !== boards.length || after.config.boards.some((b, i) => same(b) !== same(boards[i]!)))
    return null;
  return next;
}

// Switches one of a board's built-in rules on or off in config.toml's text, as its `off` list says; null when this can't
// (no such board, or its `off` isn't on one line). Leaves the text as it is when it already says so.
export function switchBuiltIn(text: string, board: string, rule: string, on: boolean): string | null {
  const parsed = Result.try({ try: (): Raw => parse(text), catch: tomlError });
  if (Result.isFailure(parsed) || !Array.isArray(parsed.success.boards)) return null;
  const raw: unknown[] = parsed.success.boards;
  const i = raw.findIndex((b) => field(b, "id") === board);
  const parts = boardTables(text, raw.length);
  if (i < 0 || !parts) return null;
  const part = parts[i + 1]!;
  const own = part.slice(0, tableEnd(part));
  const off = field(raw[i], "off");
  const was = Array.isArray(off) ? off.map(String) : [];
  const next = on ? was.filter((x) => x !== rule) : was.includes(rule) ? was : [...was, rule];
  if (next.length === was.length && next.every((x, k) => x === was[k])) return text;
  const line = `off = [${next.map(toml).join(", ")}]`;
  const at = /^([ \t]*)off[ \t]*=[ \t]*\[[^\n\]]*\][ \t]*(#[^\n]*)?(\r?\n|$)/m.exec(own);
  let edited: string;
  if (at) {
    const tail = at[2] ? ` ${at[2]}` : "";
    edited = own.slice(0, at.index) + (next.length ? `${at[1]}${line}${tail}${at[3]}` : "") + own.slice(at.index + at[0].length);
  } else {
    if (/^[ \t]*off[ \t]*=/m.test(own)) return null;
    const head = /^([ \t]*)builtin[ \t]*=[^\n]*(\r?\n|$)/m.exec(own);
    if (!head) return null;
    const end = head.index + head[0].length;
    edited = own.slice(0, end) + (head[2] ? "" : "\n") + `${head[1]}${line}\n` + own.slice(end);
  }
  parts[i + 1] = edited + part.slice(own.length);
  return parts.join("");
}
