// The models and effort levels your chosen agent takes, for Settings' dropdowns. Each agent's own: Claude Code names
// aliases in its --model help, Codex lists its catalog with `codex debug models`, OpenCode with `opencode models`.
// What can't be read is an empty list: the window then offers only your agent's default and what's set.
import { Effect, Result } from "effect";
import { claudeSpawn, codexCommand, codexMissing, opencodeCommand, opencodeMissing, runCommand } from "./review.ts";
import { field, isRecord, str } from "./narrow.ts";

export interface Choice {
  value: string;
  label: string;
}

export interface AgentModels {
  models: Choice[];
  efforts: Choice[];
}

const choice = (value: string, label = value): Choice => ({ value, label });
const LEVEL: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
const levels = (names: string[]) => names.map((n) => choice(n, LEVEL[n] ?? n));

// Claude Code lists no models; its --model takes these aliases for the latest of each, and --effort these levels.
export const CLAUDE_MODELS: AgentModels = {
  models: [choice("fable", "Fable"), choice("opus", "Opus"), choice("sonnet", "Sonnet"), choice("haiku", "Haiku")],
  efforts: levels(["low", "medium", "high", "xhigh", "max"]),
};

// Codex's catalog (`codex debug models`): the models it lists, that reason (the rest make images or audio), in its own
// order; the efforts are the levels any of them takes.
function codexCatalog(json: string): AgentModels {
  const read = Result.try({ try: (): unknown => JSON.parse(json), catch: () => null });
  const listed = field(Result.getOrNull(read), "models");
  const rows = (Array.isArray(listed) ? listed : []).filter(isRecord).flatMap((m) => {
    const slug = str(m.slug);
    const reasons = field(m, "supported_reasoning_levels");
    const efforts = (Array.isArray(reasons) ? reasons : []).flatMap((r) => str(field(r, "effort")) ?? []);
    if (!slug || m.visibility !== "list" || !efforts.length) return [];
    return [{ model: choice(slug, str(m.display_name) ?? slug), efforts, priority: typeof m.priority === "number" ? m.priority : 0 }];
  });
  rows.sort((a, b) => a.priority - b.priority);
  const all = new Set(rows.flatMap((r) => r.efforts));
  return { models: rows.map((r) => r.model), efforts: levels(Object.keys(LEVEL).filter((l) => all.has(l))) };
}

export const codexModels = (command = codexCommand()): Effect.Effect<AgentModels> =>
  Effect.gen(function* () {
    const spawnAs = yield* claudeSpawn(command, ["debug", "models"]);
    return codexCatalog(yield* runCommand(spawnAs, { timeout: 20_000, missing: codexMissing(command) }));
  }).pipe(Effect.orElseSucceed((): AgentModels => ({ models: [], efforts: [] })));

// `opencode models`: one provider/model a line. OpenCode takes no effort.
export const opencodeModels = (command = opencodeCommand()): Effect.Effect<AgentModels> =>
  Effect.gen(function* () {
    const spawnAs = yield* claudeSpawn(command, ["models"]);
    const out = yield* runCommand(spawnAs, { timeout: 20_000, missing: opencodeMissing(command) });
    const models = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[\w.-]+\/\S+$/.test(l));
    return { models: models.map((m) => choice(m)), efforts: [] };
  }).pipe(Effect.orElseSucceed((): AgentModels => ({ models: [], efforts: [] })));

export const modelsOf = (harness: string): Effect.Effect<AgentModels> =>
  harness === "codex" ? codexModels() : harness === "opencode" ? opencodeModels() : Effect.succeed(CLAUDE_MODELS);
