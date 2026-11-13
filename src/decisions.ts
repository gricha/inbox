// OpenRouter's Decisions API (alpha): typed questions about a `state`, answered by a decision model (TypeSafe's Jev) with
// probabilities and no prose. Its one caller is an automation's question, and only once you've set its key in Settings:
// with none, nothing here runs. https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request
import { Effect, Result } from "effect";
import { DecisionModelDown, DecisionModelError } from "./errors.ts";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const TIMEOUT = 30_000;

// The two kinds the desk asks: yes or no, and one of a set you name. criteria says what each answer means.
export type Question =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

// noul: the probability of yes. choice: the option picked and, when the model gives them, each option's probability.
// refusal: the provider declined this question.
export type Answer =
  { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities?: Record<string, number> } | { type: "refusal" };

export interface DecideOpts {
  key: string; // an OpenRouter key: only ever in the Authorization header
  model: string;
  url?: string; // tests point it at a local server
}

const DOWN: Record<number, string> = {
  401: "OpenRouter refused the decision model's key (401). Check it in Settings → Local Agent Integration.",
  402: "OpenRouter says the decision model's key is out of credits (402). Add credits, or clear the key in Settings → Local Agent Integration and Claude answers instead.",
  429: "OpenRouter is rate limiting the decision model (429).",
};

function answerOf(raw: unknown): Answer | null {
  const a = (raw ?? {}) as { type?: unknown; noul?: unknown; choice?: unknown; probabilities?: unknown };
  if (a.type === "refusal") return { type: "refusal" };
  if (a.type === "noul" && typeof a.noul === "number") return { type: "noul", noul: a.noul };
  if (a.type !== "choice" || typeof a.choice !== "string") return null;
  const p = a.probabilities && typeof a.probabilities === "object" ? (a.probabilities as Record<string, unknown>) : null;
  const numbers = p && Object.values(p).every((v) => typeof v === "number") ? (p as Record<string, number>) : undefined;
  return { type: "choice", choice: a.choice, ...(numbers && { probabilities: numbers }) };
}

// One request: every question is about the same state, and each is answered on its own. A question the answer leaves out,
// or answers as another type, fails it: never a default. The key is cut from anything that comes back in an error.
export const decide = Effect.fn("decide")(function* <K extends string>(
  state: unknown,
  questions: Record<K, Question>,
  opts: DecideOpts,
): Effect.fn.Return<Record<K, Answer>, DecisionModelDown | DecisionModelError> {
  const safe = (text: string) => text.replaceAll(opts.key, "[key]").slice(0, 300);
  const { status, text } = yield* Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(opts.url ?? DECISIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, state, questions }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
      });
      return { status: res.status, text: await res.text() };
    },
    // Unreachable or no answer in time is the model being down too: nothing about the item.
    catch: (cause) =>
      new DecisionModelDown({
        status: 0,
        message: `OpenRouter couldn't be reached: ${safe(cause instanceof Error ? cause.message : String(cause))}`,
      }),
  });
  const down = DOWN[status];
  if (down) return yield* new DecisionModelDown({ status, message: down });
  const read = Result.try({
    try: () => JSON.parse(text) as { answers?: unknown; error?: { message?: unknown } } | null,
    catch: (cause) => cause,
  });
  if (status >= 500) {
    const said = Result.isSuccess(read) && typeof read.success?.error?.message === "string" ? `: ${safe(read.success.error.message)}` : "";
    return yield* new DecisionModelDown({ status, message: `OpenRouter's decision model failed${said} (HTTP ${status}).` });
  }
  if (Result.isFailure(read))
    return yield* new DecisionModelError({
      status,
      message: `the decision model's answer isn't JSON (HTTP ${status})`,
      cause: read.failure,
    });
  const body = read.success;
  if (status < 200 || status >= 300) {
    const said = typeof body?.error?.message === "string" ? safe(body.error.message) : "no reason given";
    return yield* new DecisionModelError({ status, message: `the decision model failed: ${said} (HTTP ${status})` });
  }
  const answers = body?.answers && typeof body.answers === "object" ? (body.answers as Record<string, unknown>) : {};
  const out = {} as Record<K, Answer>;
  for (const name of Object.keys(questions) as K[]) {
    const a = answerOf(answers[name]);
    const asked = questions[name].type;
    if (!a || (a.type !== "refusal" && a.type !== asked))
      return yield* new DecisionModelError({ status, message: `the decision model gave no ${asked} answer to "${name}"` });
    out[name] = a;
  }
  return out;
});
