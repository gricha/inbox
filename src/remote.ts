// Using the desk from your other devices over Tailscale: `tailscale serve` in front of a second loopback listener that
// only it reaches, and each of your devices paired once with a one-time code for a token of its own (docs/api.md →
// Security model).
import crypto from "node:crypto";
import { Effect, Result } from "effect";
import { Forbidden, NotFound, TailscaleError, TooManyRequests } from "./errors.ts";
import { field, isRecord, str, strings } from "./narrow.ts";
import { claudeSpawn, runCommand } from "./review.ts";
import type { Store } from "./store.ts";
import type { Device } from "./types.ts";

// This machine's name on the tailnet (no trailing dot), and the login whose devices may use the desk.
export interface Tailnet {
  name: string;
  login: string;
}

const TIMEOUT = 15_000;
const HTTPS = "--https=443";

const tailscale = (args: string[]): Effect.Effect<string, TailscaleError> =>
  Effect.flatMap(claudeSpawn("tailscale", args), (s) =>
    runCommand(s, { timeout: TIMEOUT, missing: "Tailscale isn't installed here: there's no tailscale command." }),
  ).pipe(Effect.mapError((e) => new TailscaleError({ message: e.message, cause: e })));

const parsed = (text: string, what: string): Effect.Effect<Record<string, unknown>, TailscaleError> => {
  const r = Result.try({ try: (): unknown => JSON.parse(text), catch: () => null });
  const v = Result.isSuccess(r) ? r.success : null;
  return isRecord(v) ? Effect.succeed(v) : Effect.fail(new TailscaleError({ message: `${what} didn't answer JSON` }));
};

// From `tailscale status --json`: Self.DNSName, its HTTPS certificate names, and the login that owns this machine.
export const readTailnet = Effect.fnUntraced(function* (login: string): Effect.fn.Return<Tailnet, TailscaleError> {
  const s = yield* parsed(yield* tailscale(["status", "--json"]), "tailscale status");
  const fail = (message: string) => Effect.fail(new TailscaleError({ message }));
  if (s.BackendState !== "Running") return yield* fail("Tailscale isn't running or signed in here: open Tailscale and sign in.");
  const name = (str(field(s.Self, "DNSName")) ?? "").replace(/\.$/, "").toLowerCase();
  if (!name) return yield* fail("Tailscale gives this machine no name: turn on MagicDNS in your tailnet's DNS settings.");
  if (!(strings(s.CertDomains) ?? []).map((d) => d.toLowerCase()).includes(name))
    return yield* fail("Your tailnet has no HTTPS certificates: turn on HTTPS in its DNS settings in Tailscale's admin console.");
  const owner = str(field(field(s.User, String(field(s.Self, "UserID"))), "LoginName")) ?? "";
  const who = (login.trim() || owner).toLowerCase();
  if (!who) return yield* fail("Tailscale doesn't say whose machine this is: set Tailscale login allowed in.");
  return { name, login: who };
});

// `tailscale serve` in the background on https://<name>/ to `target`, unless it already serves something there that isn't
// the desk's (`mine`, the target the desk set last).
export const serveOn = Effect.fnUntraced(function* (
  name: string,
  target: string,
  mine: string | null,
): Effect.fn.Return<void, TailscaleError> {
  const cfg = yield* parsed(yield* tailscale(["serve", "status", "--json"]), "tailscale serve status");
  const byPath = field(field(cfg.Web, `${name}:443`), "Handlers");
  const handlers = isRecord(byPath) ? Object.entries(byPath) : [];
  const used = handlers.length > 0 || !!field(cfg.TCP, "443");
  const ours = handlers.length === 1 && handlers[0]![0] === "/" && !!mine && field(handlers[0]![1], "Proxy") === mine;
  if (used && !ours)
    return yield* new TailscaleError({
      message: `tailscale serve already serves https://${name}/: turn that off first (tailscale serve ${HTTPS} off)`,
    });
  return yield* Effect.asVoid(tailscale(["serve", "--bg", HTTPS, target]));
});

export const serveOff = tailscale(["serve", HTTPS, "off"]).pipe(Effect.asVoid);

// sha256, hex: what the store keeps of a token, and what a pairing code is kept as.
const digest = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
const CODE_MS = 10 * 60_000;
const TRIES = 5; // pairing attempts a minute, from anyone
const USED_MS = 60_000; // how often a device's last use is written

const codeOf = (typed: string) => typed.toUpperCase().replaceAll(/[^0-9A-Z]/g, "");
// A device's name as it's shown: one short line.
const nameOf = (s: unknown, fallback: string) =>
  (typeof s === "string"
    ? s
        .replaceAll(/\p{Cc}+/gu, " ")
        .trim()
        .slice(0, 60)
    : "") || fallback;

const shown = (d: Device): Device => ({
  id: d.id,
  name: d.name,
  kind: d.kind,
  created_at: d.created_at,
  last_used_at: d.last_used_at,
});

export class Remote {
  // While the desk serves over Tailscale; null otherwise, and then the remote listener refuses everything.
  tailnet: Tailnet | null = null;
  wanted = false; // the setting, or desk serve --tailscale
  text = "Off.";
  private code: { hash: string; until: number } | null = null;
  private tries: number[] = [];
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  get url(): string | null {
    return this.tailnet ? `https://${this.tailnet.name}` : null;
  }

  // One code at a time: a new one replaces the last.
  mint(): { code: string; expires_at: string } {
    const raw = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
    const until = this.now() + CODE_MS;
    this.code = { hash: digest(raw), until };
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires_at: new Date(until).toISOString() };
  }

  // A device's token, once: only its hash is kept.
  issue(name: unknown, kind: Device["kind"]): { token: string; device: Device } {
    const token = `inbox_${crypto.randomBytes(32).toString("base64url")}`;
    const device: Device = {
      id: crypto.randomBytes(8).toString("hex"),
      name: nameOf(name, kind === "browser" ? "A browser" : "A device"),
      kind,
      created_at: new Date(this.now()).toISOString(),
      last_used_at: null,
    };
    this.store.addDevice({ ...device, hash: digest(token) });
    return { token, device };
  }

  // The code for a token. Any try burns the code, right or wrong, and a few a minute is all anyone gets.
  trade(
    typed: unknown,
    name: unknown,
    kind: Device["kind"],
  ): Effect.Effect<{ token: string; device: Device }, Forbidden | TooManyRequests> {
    return Effect.suspend((): Effect.Effect<{ token: string; device: Device }, Forbidden | TooManyRequests> => {
      const t = this.now();
      this.tries = this.tries.filter((at) => at > t - 60_000);
      if (this.tries.length >= TRIES) return Effect.fail(new TooManyRequests({ message: "too many pairing attempts: wait a minute" }));
      this.tries.push(t);
      const code = this.code;
      this.code = null;
      const ok = !!code && code.until > t && typeof typed === "string" && same(digest(codeOf(typed)), code.hash);
      if (!ok) return Effect.fail(new Forbidden({ message: "that pairing code isn't valid: run desk pair again for a new one" }));
      return Effect.succeed(this.issue(name, kind));
    });
  }

  // The device a token is, of that kind; null for none, a revoked one or one of the other kind.
  verify(token: string | undefined, kind: Device["kind"]): Device | null {
    if (!token) return null;
    const hash = digest(token);
    let found: (Device & { hash: string }) | null = null;
    for (const d of this.store.devices()) if (same(d.hash, hash) && d.kind === kind) found = d;
    if (!found) return null;
    const at = new Date(this.now());
    if (!found.last_used_at || at.getTime() - Date.parse(found.last_used_at) > USED_MS) this.store.usedDevice(found.id, at.toISOString());
    return shown(found);
  }

  devices(): Device[] {
    return this.store.devices().map(shown);
  }

  revoke(id: string): Effect.Effect<void, NotFound> {
    return Effect.suspend(() =>
      this.store.removeDevice(id) ? Effect.void : Effect.fail(new NotFound({ message: `no paired device ${id}` })),
    );
  }
}
