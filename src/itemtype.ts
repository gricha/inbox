// An automation's declared item type: TypeScript source for what its notes' fields are (an Email), made into an Effect
// Schema the desk decodes each note with, the JSON Schema a run fills them by, and the item.<field> paths its rules read.
// TypeScript 7 has no JS API, so this reads a small subset itself and refuses the rest, saying what it doesn't support.
import { Result, Schema } from "effect";
import { isRecord } from "./narrow.ts";
import type { ItemField, NoteFact, TypeRefusal } from "./types.ts";

const SUBSET =
  'a type here is an object literal ({ a: string }) of string, number, boolean, string literals ("a" | "b"), unions of those, optional fields (a?: T), nested object literals and arrays (T[])';
const MAX = 4_000;

type Shape =
  | { t: "string" }
  | { t: "number" }
  | { t: "boolean" }
  | { t: "lit"; v: string }
  | { t: "union"; of: Shape[] }
  | { t: "array"; of: Shape }
  | { t: "object"; fields: { key: string; optional: boolean; of: Shape }[] };

export interface ItemType {
  name: string; // the declared name: "Email"
  schema: Schema.Codec<unknown, unknown>;
  json: object; // the JSON Schema a run's notes fill their `fields` by
  fields: ReadonlySet<string>; // what a rule may name: item.kind, item.sender, item.amount
  shape: Shape; // what the note's facts are read by
  declared: ItemField[]; // the same, each with its type as written, for the editor
}

type Tok = { k: "id" | "str" | "num" | "p"; v: string; at: number };

class Refused extends Error {
  at: number | null; // where in the source; null for the whole of it
  constructor(message: string, at: number | null) {
    super(message);
    this.at = at;
  }
}

function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const skip = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (skip) {
      i += skip[0].length;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(rest) ?? /^"(?:[^"\\\n]|\\.)*"|^'(?:[^'\\\n]|\\.)*'/.exec(rest) ?? /^-?\d[\d_.eE+-]*/.exec(rest);
    if (m) {
      const k = /^[A-Za-z_$]/.test(m[0]) ? "id" : /^["']/.test(m[0]) ? "str" : "num";
      out.push({ k, v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const p = /^(=>|\.\.\.|[{}[\]()<>|&;,:?=.])/.exec(rest);
    if (!p) throw new Refused(`${where(src, i)}: "${src.charAt(i)}" isn't TypeScript the desk reads`, i);
    out.push({ k: "p", v: p[0], at: i });
    i += p[0].length;
  }
  return out;
}

const lineCol = (src: string, at: number) => {
  const before = src.slice(0, at).split("\n");
  return { line: before.length, column: before.at(-1)!.length + 1 };
};
const where = (src: string, at: number) => {
  const { line, column } = lineCol(src, at);
  return `line ${line}, column ${column}`;
};

// A string literal's value: JSON's escapes, either quote.
const unquote = (s: string): string => {
  const body = s.slice(1, -1);
  const json = s.startsWith("'") ? body.replaceAll("\\'", "'").replaceAll('"', '\\"') : body;
  const v: unknown = Result.getOrNull(Result.try({ try: (): unknown => JSON.parse(`"${json}"`), catch: () => null }));
  if (typeof v !== "string") throw new Refused(`can't read the string ${s}`, null);
  return v;
};

function parse(src: string): { name: string; shape: Shape } {
  const ts = tokens(src);
  let i = 0;
  const peek = () => ts[i];
  const at = (t: Tok | undefined) => (t ? where(src, t.at) : "the end");
  const pos = (t: Tok | undefined) => t?.at ?? src.length;
  const refuse = (t: Tok | undefined, what: string): never => {
    throw new Refused(`${at(t)}: ${what} isn't supported; ${SUBSET}`, pos(t));
  };
  const take = (v: string) => {
    const t = ts[i];
    if (t?.v !== v) throw new Refused(`${at(t)}: expected "${v}"${t ? `, got "${t.v}"` : ""}`, pos(t));
    i++;
  };
  const eat = (v: string) => {
    if (ts[i]?.v !== v) return false;
    i++;
    return true;
  };

  function union(): Shape {
    eat("|");
    const of = [arrayed()];
    while (eat("|")) of.push(arrayed());
    if (peek()?.v === "&") refuse(peek(), "an intersection (&)");
    return of.length === 1 ? of[0]! : { t: "union", of };
  }
  function arrayed(): Shape {
    let s = primary();
    while (peek()?.v === "[") {
      i++;
      if (peek()?.v !== "]") refuse(peek(), "an indexed access type (T[K])");
      i++;
      s = { t: "array", of: s };
    }
    return s;
  }
  function primary(): Shape {
    const t = ts[i++];
    if (!t) throw new Refused(`the type ends early: expected a type at the end`, src.length);
    if (t.k === "str") return { t: "lit", v: unquote(t.v) };
    if (t.k === "num") return refuse(t, `the number literal ${t.v}`);
    if (t.v === "{") return object();
    if (t.v === "(") {
      if (peek()?.v === ")" || peek()?.v === "...") return refuse(t, "a function type");
      const s = union();
      take(")");
      if (peek()?.v === "=>") refuse(peek(), "a function type");
      return s;
    }
    if (t.v === "[") return refuse(t, "a tuple ([A, B])");
    if (t.k === "id") {
      if (t.v === "string" || t.v === "number" || t.v === "boolean") return { t: t.v };
      if (t.v === "readonly") return primary();
      if ((t.v === "Array" || t.v === "ReadonlyArray") && peek()?.v === "<") {
        i++;
        const of = union();
        take(">");
        return { t: "array", of };
      }
      const hint =
        t.v === "Date"
          ? " (use string, an ISO date)"
          : t.v === "true" || t.v === "false"
            ? " (use boolean)"
            : t.v === "null" || t.v === "undefined"
              ? " (make the field optional: a?: T)"
              : "";
      return refuse(t, `"${t.v}"${hint}`);
    }
    return refuse(t, `"${t.v}"`);
  }
  function object(): Shape {
    const fields: { key: string; optional: boolean; of: Shape }[] = [];
    while (!eat("}")) {
      if (peek()?.v === "readonly" && ts[i + 1]?.v !== ":" && ts[i + 1]?.v !== "?") i++;
      const k = ts[i++];
      if (!k) throw new Refused("the type ends early: a { isn't closed", src.length);
      if (k.v === "[") refuse(k, "an index signature ([key: string]: T)");
      if (k.k !== "id" && k.k !== "str") refuse(k, `"${k.v}" as a field's name`);
      const key = k.k === "str" ? unquote(k.v) : k.v;
      if (!/^[a-z_][a-z0-9_]*$/i.test(key)) refuse(k, `the field name "${key}" (rules read item.<name>: letters, digits and _)`);
      if (fields.some((f) => f.key === key)) throw new Refused(`${at(k)}: "${key}" is there twice`, k.at);
      const optional = eat("?");
      if (peek()?.v === "(" || peek()?.v === "<") refuse(peek(), "a method");
      take(":");
      fields.push({ key, optional, of: union() });
      if (!eat(";")) eat(",");
    }
    return { t: "object", fields };
  }

  eat("export");
  const kw = ts[i++];
  if (kw?.v !== "type" && kw?.v !== "interface") throw new Refused(`start it with type Name = { … } or interface Name { … }`, pos(kw));
  const n = ts[i++];
  if (n?.k !== "id" || !/^[A-Z]/.test(n.v)) throw new Refused(`${at(n)}: name the type, capitalized: type Email = { … }`, pos(n));
  if (peek()?.v === "<") refuse(peek(), "a generic type");
  if (kw.v === "interface") {
    if (peek()?.v === "extends") refuse(peek(), "extends");
    take("{");
  } else take("=");
  const shape = kw.v === "interface" ? object() : union();
  eat(";");
  if (i < ts.length) throw new Refused(`${at(ts[i])}: one type only, and nothing after it`, pos(ts[i]));
  if (shape.t !== "object") throw new Refused(`${n.v} is an object literal: the item's fields`, n.at);
  return { name: n.v, shape };
}

type Codec = Schema.Codec<unknown, unknown>;

function schemaOf(s: Shape): Codec {
  if (s.t === "string") return Schema.String;
  if (s.t === "number") return Schema.Finite; // JSON has no NaN or Infinity, so neither does a run's answer
  if (s.t === "boolean") return Schema.Boolean;
  if (s.t === "lit") return Schema.Literal(s.v);
  if (s.t === "array") return Schema.Array(schemaOf(s.of));
  if (s.t === "union") {
    const lits = s.of.flatMap((x) => (x.t === "lit" ? [x.v] : []));
    return lits.length === s.of.length ? Schema.Literals(lits) : Schema.Union(s.of.map(schemaOf));
  }
  const fields: Record<string, Codec | Schema.optionalKey<Codec>> = {};
  for (const f of s.fields) fields[f.key] = f.optional ? Schema.optionalKey(schemaOf(f.of)) : schemaOf(f.of);
  return Schema.Struct(fields);
}

// A rule reads what the expression language holds: strings, numbers, booleans and lists of them, not lists of objects.
const leaf = (s: Shape): boolean =>
  s.t === "string" ||
  s.t === "number" ||
  s.t === "boolean" ||
  s.t === "lit" ||
  (s.t === "union" && s.of.every(leaf)) ||
  (s.t === "array" && leaf(s.of));

// A leaf's shape as TypeScript, for the editor's list of fields.
function typeText(s: Shape): string {
  if (s.t === "lit") return JSON.stringify(s.v);
  if (s.t === "union") return s.of.map(typeText).join(" | ");
  if (s.t === "array") return s.of.t === "union" ? `(${typeText(s.of)})[]` : `${typeText(s.of)}[]`;
  return s.t;
}

// An optional object's fields are as optional as it is.
function paths(s: Shape, at: string, optional: boolean): ItemField[] {
  if (s.t !== "object") return leaf(s) ? [{ path: at, type: typeText(s), optional }] : [];
  return s.fields.flatMap((f) => paths(f.of, `${at}.${f.key}`, optional || f.optional));
}

// The automation's type, read: its Schema, its JSON Schema and its rules' fields; or what about it isn't supported, and where.
export function readType(source: string): Result.Result<ItemType, TypeRefusal> {
  if (source.length > MAX) return Result.fail({ message: `keep it under ${MAX} characters`, line: null, column: null });
  return Result.try({
    try: (): ItemType => {
      const { name, shape } = parse(source);
      const schema = schemaOf(shape);
      const json = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema;
      const declared = paths(shape, "item", false);
      return { name, schema, json, fields: new Set(declared.map((f) => f.path)), shape, declared };
    },
    catch: (e): TypeRefusal => {
      if (!(e instanceof Refused)) throw e; // a bug here, not in the type
      return { message: e.message, ...(e.at === null ? { line: null, column: null } : lineCol(source, e.at)) };
    },
  });
}

// The same, its refusal in words alone.
export const itemType = (source: string): Result.Result<ItemType, string> => Result.mapError(readType(source), (r) => r.message);

// A note's fields checked against its type: them, decoded; or every way they don't fit, as Effect words it.
export function fit(t: ItemType, fields: unknown): Result.Result<Record<string, unknown>, string> {
  return Schema.decodeUnknownResult(t.schema, { errors: "all" })(fields).pipe(
    Result.mapError((e) => e.message),
    // A type is an object literal (parse() refuses the rest), so what it decodes is a record.
    Result.flatMap((v) => (isRecord(v) ? Result.succeed(v) : Result.fail(`${t.name} isn't an object`))),
  );
}

// A saved automation's type, read once per source: null without one, or with one this desk no longer reads.
const read = new Map<string, ItemType | null>();
export function typeOf(a: { type?: string | undefined }): ItemType | null {
  if (!a.type) return null;
  const was = read.get(a.type);
  if (was !== undefined) return was;
  if (read.size >= 100) read.clear();
  const t = Result.getOrNull(itemType(a.type));
  read.set(a.type, t);
  return t;
}

const FACTS_MAX = 12;
const VALUE_MAX = 200;
// An ISO date or time, as a run is told to write one: 2026-11-27, or with its time.
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// A field's name in words: due → Due, sender_name and senderName → Sender name.
const humanize = (key: string): string => {
  const words = key
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const line = (s: string) => {
  const one = s.replaceAll(/\s+/g, " ").trim();
  return one.length > VALUE_MAX ? `${one.slice(0, VALUE_MAX - 1)}…` : one;
};
const literal = (s: Shape | undefined): boolean => s?.t === "lit" || (s?.t === "union" && s.of.every(literal));

// One value as text: an enum's word humanized, a number as written, a string as it is on one line.
function textOf(v: unknown, s: Shape | undefined): string | null {
  if (typeof v === "string") return line(literal(s) ? humanize(v) : v) || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return null;
}

function factOf(label: string, v: unknown, s: Shape | undefined): NoteFact[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    const of = s?.t === "array" ? s.of : undefined;
    const said = v.map((x) => textOf(x, of));
    return said.length && said.every((x) => x !== null) ? [{ label, text: line(said.join(", ")) }] : [];
  }
  if (typeof v === "object") {
    const at = s?.t === "object" ? s : undefined;
    return Object.entries(v).flatMap(([k, x]) =>
      factOf(`${label} ${humanize(k).toLowerCase()}`, x, at?.fields.find((f) => f.key === k)?.of),
    );
  }
  if (typeof v === "number" && Number.isFinite(v)) return [{ label, number: v }];
  if (typeof v === "string" && !literal(s) && ISO.test(v.trim()) && !Number.isNaN(Date.parse(v))) return [{ label, date: v.trim() }];
  const text = textOf(v, s);
  return text === null ? [] : [{ label, text }];
}

// A note's fields as facts: in its type's order, by what each field is; without a type (its automation is gone), by what
// each value is. A field left out has no fact.
export function factsOf(t: ItemType | null, fields: Record<string, unknown>): NoteFact[] {
  const shape = t?.shape.t === "object" ? t.shape : null;
  const keys = shape ? shape.fields.map((f) => f.key) : Object.keys(fields);
  return keys.flatMap((k) => factOf(humanize(k), fields[k], shape?.fields.find((f) => f.key === k)?.of)).slice(0, FACTS_MAX);
}
