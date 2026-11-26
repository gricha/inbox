// The light model: one role for the desk's small, frequent asks (the judge's sort, the Inbox's score, your rules' questions,
// and short reads such as who a bot's PR is for). Its chain: each external provider you configured, then your
// subscription's cheap tier. docs/api.md → The light model.
import { Effect } from "effect";
import type { DecideOpts } from "./decisions.ts";
import { DecisionModelDown, messageOf, type ClaudeError, type CommandError, type FsError } from "./errors.ts";
import { askAgent, makeAgentDir, runsOf, type AgentRuns, type AskOpts, type ClaudeAnswer } from "./review.ts";
import type { DriverId } from "./agents.ts";
import { agentName, TIERS, type Settings } from "./settings.ts";

export interface LightRun {
  model?: string;
  effort?: string;
}

// What runs it on your subscription: what you set, else your agent's cheap tier (Haiku or Luna at low; OpenCode's own
// default, which takes no effort).
export function lightModel(s: Settings): LightRun {
  const harness = s["agent.harness"];
  const tier = TIERS[harness];
  const model = s["agent.light_model"] || tier?.model;
  const effort = harness === "opencode" ? "" : s["agent.light_effort"] || tier?.effort;
  return { ...(model && { model }), ...(effort && { effort }) };
}

// An external provider, asked before your subscription. Each says which kinds of ask it takes: `decide`, yes-or-no and
// pick-one questions (OpenRouter's Decisions API). One that takes a prompt and a schema would add its own and be one more entry.
export interface Provider {
  name: string; // who answered, as the desk says it
  decide?: DecideOpts;
}

// Codex and OpenRouter word an unknown model differently: "… is not a valid model ID", "model … is not supported".
const NO_MODEL =
  /not a valid model|model\b.{0,80}\b(does not exist|doesn't exist|not found|not supported|isn't supported|not available)|unknown model|invalid model/i;

interface Host {
  settings: Settings;
  home: string;
  decisions: string | undefined;
  agent(): DriverId;
  agentRuns(): AgentRuns;
  log(msg: string): void;
}

export class Light {
  desk: Host;
  missing = new Set<string>(); // "agent:model": a tier model your agent said it doesn't have; its default runs instead

  constructor(desk: Host) {
    this.desk = desk;
  }

  // The external providers configured now, in the order they're asked.
  providers(): Provider[] {
    const s = this.desk.settings;
    const key = s["agent.decision_key"];
    const model = s["agent.decision_model"];
    const url = this.desk.decisions;
    return key ? [{ name: model, decide: { key, model, ...(url !== undefined && { url }) } }] : [];
  }

  // Who answers when no external provider does.
  tierName(): string {
    return agentName(this.desk.settings["agent.harness"]);
  }

  // Who answers first for an ask of this kind.
  first(kind: "decide"): string {
    return this.providers().find((p) => p[kind])?.name ?? this.tierName();
  }

  // The call down the chain: each provider that takes it (`via` gives its call, or null), then `tier`. A provider that's
  // down or out of credits passes this call on; what fails on the tier is the call's.
  chain<A, E1, E2>(
    via: (p: Provider) => Effect.Effect<A, E1> | null,
    tier: () => Effect.Effect<A, E2>,
  ): Effect.Effect<{ answer: A; by: string }, E1 | E2> {
    let out: Effect.Effect<{ answer: A; by: string }, E1 | E2> = Effect.suspend(() =>
      Effect.map(tier(), (answer) => ({ answer, by: this.tierName() })),
    );
    for (const p of this.providers().toReversed()) {
      const call = via(p);
      if (!call) continue;
      const next = out;
      out = call.pipe(
        Effect.map((answer) => ({ answer, by: p.name })),
        Effect.catch((e) => {
          if (!(e instanceof DecisionModelDown)) return Effect.fail(e);
          this.desk.log(`light model: ${p.name} can't answer (${e.message}); ${this.tierName()} answers this call`);
          return next;
        }),
      );
    }
    return out;
  }

  // One tool-less call on your subscription's light model. A tier model your agent says it doesn't have (an account
  // without Luna) gives way to its default, for the rest of the desk's run; a model you set fails as itself.
  ask(prompt: string, schema: object): Effect.Effect<ClaudeAnswer, CommandError | ClaudeError | FsError> {
    return Effect.gen({ self: this }, function* () {
      const desk = this.desk;
      const agent = desk.agent();
      const run = lightModel(desk.settings);
      // Without a light model of its own, or one your agent doesn't have, it runs on your agent's model: never on the CLI's
      // own default, which can be a model you never picked here.
      const yours = runsOf(agent, desk.agentRuns());
      const tier = !desk.settings["agent.light_model"] && run.model ? `${agent}:${run.model}` : null;
      const base = { schema, dir: yield* makeAgentDir(desk.home), agent };
      // Gone to your agent's model, it keeps the light model's effort.
      const instead: AskOpts = { ...base, ...yours, ...(run.effort && { effort: run.effort }) };
      const opts: AskOpts = tier && this.missing.has(tier) ? instead : { ...base, ...yours, ...run };
      return yield* askAgent(prompt, opts).pipe(
        Effect.catch((e) => {
          if (!tier || this.missing.has(tier) || !NO_MODEL.test(messageOf(e))) return Effect.fail(e);
          this.missing.add(tier);
          desk.log(`light model: ${agentName(agent)} has no ${run.model}; your agent's model runs instead`);
          return askAgent(prompt, instead);
        }),
      );
    });
  }
}
