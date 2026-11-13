// Values whose type TypeScript can't know (parsed JSON, a SQL row, a caught error, a key from a string) are checked here,
// never cast: `typescript/no-unsafe-type-assertion` is an error everywhere but tests, and its disables are in this file,
// where a check has already proven what the cast says, plus the few test/no-casts.test.ts counts.
import { Result, Schema } from "effect";

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// One field of something that may not be an object: undefined when it isn't, or hasn't it.
export const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? v.filter((x) => typeof x === "string") : undefined;

// A string that is one of a record's keys (a Record<Id, …> table's id).
export const isKeyOf = <T extends object>(o: T, k: PropertyKey): k is keyof T => Object.hasOwn(o, k);

// A string that is one of a list's values ("low" | "medium" | "high").
export const oneOf = <const T extends string>(list: readonly T[], v: unknown): T | undefined => list.find((x) => x === v);

// An object's own keys, typed as its keys: Object.keys widens them to string.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.keys of a T are T's own keys
export const keysOf = <T extends object>(o: T): (keyof T & string)[] => Object.keys(o) as (keyof T & string)[];

// An object built from entries whose keys are all of K, typed as such: Object.fromEntries widens them to string.
export const fromEntries = <K extends string, V>(entries: Iterable<readonly [K, V]>): Record<K, V> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every key came from K
  Object.fromEntries(entries) as Record<K, V>;

// JSON text checked against a schema: the value, or why it isn't one.
export const parseJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string): Result.Result<S["Type"], string> =>
  Result.try({ try: (): unknown => JSON.parse(text), catch: (e) => (e instanceof Error ? e.message : String(e)) }).pipe(
    Result.flatMap((v) => decode(schema, v)),
  );

// A value checked against a schema: the value, or why it isn't one.
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, v: unknown): Result.Result<S["Type"], string> =>
  Schema.decodeUnknownResult(schema)(v).pipe(Result.mapError((e) => e.message));

// A kept list or table checked entry by entry, so one entry in an old shape doesn't take the rest with it: those that
// aren't one are left out, and what isn't a list (or an object) at all reads as empty.
export const decodeEach = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, v: unknown): S["Type"][] =>
  Array.isArray(v) ? v.flatMap((x) => Result.match(decode(schema, x), { onSuccess: (y) => [y], onFailure: () => [] })) : [];
export const decodeValues = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, v: unknown): Record<string, S["Type"]> =>
  Object.fromEntries(
    Object.entries(isRecord(v) ? v : {}).flatMap(([k, x]) =>
      Result.match(decode(schema, x), { onSuccess: (y) => [[k, y] as const], onFailure: () => [] }),
    ),
  );

// A schema kept beside an interface, refused unless it decodes to exactly T (readonly aside): one that left out a field
// would strip it from every value it decodes.
type Same<X, Y> = (<G>(g: G) => G extends X ? 1 : 2) extends <G>(g: G) => G extends Y ? 1 : 2 ? true : false;
type Writable<T> = T extends readonly (infer E)[] ? Writable<E>[] : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> } : T;
export const schemaOf =
  <T>() =>
  <S extends Schema.Top>(s: Same<Writable<S["Type"]>, T> extends true ? S : never): S =>
    s;

// An error's own code ("ENOENT"), from whatever was thrown.
export const codeOf = (e: unknown): string | undefined => str(field(e, "code"));
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
