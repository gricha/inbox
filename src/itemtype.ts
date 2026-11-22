// An automation's declared item type: TypeScript source for what its notes' fields are (an Email), made into an Effect
// Schema the desk decodes each note with, the JSON Schema a run fills them by, and the item.<field> paths its rules read.
// TypeScript 7 has no JS API, so this reads a small subset itself and refuses the rest, saying what it doesn't support.
import { Result, Schema } from "effect";

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
}

type Tok = { k: "id" | "str" | "num" | "p"; v: string; at: number };

class Refused extends Error {}

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
    if (!p) throw new Refused(`${where(src, i)}: "${src.charAt(i)}" isn't TypeScript the desk reads`);
    out.push({ k: "p", v: p[0], at: i });
    i += p[0].length;
  }
  return out;
}

const where = (src: string, at: number) => {
  const before = src.slice(0, at).split("\n");
  return `line ${before.length}, column ${before.at(-1)!.length + 1}`;
};

// A string literal's value: JSON's escapes, either quote.
const unquote = (s: string): string => {
  const body = s.slice(1, -1);
  const json = s.startsWith("'") ? body.replaceAll("\\'", "'").replaceAll('"', '\\"') : body;
  const v: unknown = Result.getOrNull(Result.try({ try: (): unknown => JSON.parse(`"${json}"`), catch: () => null }));
  if (typeof v !== "string") throw new Refused(`can't read the string ${s}`);
  return v;
};

function parse(src: string): { name: string; shape: Shape } {
  const ts = tokens(src);
  let i = 0;
  const peek = () => ts[i];
  const at = (t: Tok | undefined) => (t ? where(src, t.at) : "the end");
  const refuse = (t: Tok | undefined, what: string): never => {
    throw new Refused(`${at(t)}: ${what} isn't supported; ${SUBSET}`);
  };
  const take = (v: string) => {
    const t = ts[i];
    if (t?.v !== v) throw new Refused(`${at(t)}: expected "${v}"${t ? `, got "${t.v}"` : ""}`);
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
    if (!t) throw new Refused(`the type ends early: expected a type at the end`);
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
      if (!k) throw new Refused("the type ends early: a { isn't closed");
      if (k.v === "[") refuse(k, "an index signature ([key: string]: T)");
      if (k.k !== "id" && k.k !== "str") refuse(k, `"${k.v}" as a field's name`);
      const key = k.k === "str" ? unquote(k.v) : k.v;
      if (!/^[a-z_][a-z0-9_]*$/i.test(key)) refuse(k, `the field name "${key}" (rules read item.<name>: letters, digits and _)`);
      if (fields.some((f) => f.key === key)) throw new Refused(`${at(k)}: "${key}" is there twice`);
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
  if (kw?.v !== "type" && kw?.v !== "interface") throw new Refused(`start it with type Name = { … } or interface Name { … }`);
  const n = ts[i++];
  if (n?.k !== "id" || !/^[A-Z]/.test(n.v)) throw new Refused(`${at(n)}: name the type, capitalized: type Email = { … }`);
  if (peek()?.v === "<") refuse(peek(), "a generic type");
  if (kw.v === "interface") {
    if (peek()?.v === "extends") refuse(peek(), "extends");
    take("{");
  } else take("=");
  const shape = kw.v === "interface" ? object() : union();
  eat(";");
  if (i < ts.length) throw new Refused(`${at(ts[i])}: one type only, and nothing after it`);
  if (shape.t !== "object") throw new Refused(`${n.v} is an object literal: the item's fields`);
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

function paths(s: Shape, at: string): string[] {
  if (s.t !== "object") return leaf(s) ? [at] : [];
  return s.fields.flatMap((f) => paths(f.of, `${at}.${f.key}`));
}

// The automation's type, read: its Schema, its JSON Schema and its rules' fields; or what about it isn't supported.
export function itemType(source: string): Result.Result<ItemType, string> {
  if (source.length > MAX) return Result.fail(`keep it under ${MAX} characters`);
  return Result.try({
    try: (): ItemType => {
      const { name, shape } = parse(source);
      const schema = schemaOf(shape);
      const json = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema;
      return { name, schema, json, fields: new Set(paths(shape, "item")) };
    },
    catch: (e) => {
      if (e instanceof Refused) return e.message;
      throw e; // a bug here, not in the type
    },
  });
}

// A note's fields checked against its type: them, decoded; or every way they don't fit, as Effect words it.
export function fit(t: ItemType, fields: unknown): Result.Result<unknown, string> {
  return Schema.decodeUnknownResult(t.schema, { errors: "all" })(fields).pipe(Result.mapError((e) => e.message));
}
