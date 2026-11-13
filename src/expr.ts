// A small, safe expression language for rule `when` / `filter` and `why` templates.
import { Result } from "effect";
import type { Signals } from "./types.ts";
import { ExprEvalError, ExprSyntaxError } from "./errors.ts";
import { field, messageOf } from "./narrow.ts";
import { FIELDS } from "./signals.ts";
import { andMore } from "./stage.ts";

// A field's value (FIELDS leaves are strings, numbers, booleans or string lists) or a computed one.
type Value = string | number | boolean | null | undefined | Value[];

type Node =
  | { t: "lit"; v: Value }
  | { t: "name"; path: string }
  | { t: "list"; items: Node[] }
  | { t: "not"; x: Node }
  | { t: "neg"; x: Node }
  | { t: "bin"; op: string; a: Node; b: Node; re?: RegExp }
  | { t: "call"; fn: string; args: Node[] };

type Token = { k: "num" | "str" | "id" | "op" | "end"; v: string; pos: number };

const KEYWORD_OPS: Record<string, string> = { and: "&&", or: "||", not: "!", in: "in", matches: "matches" };
const FUNCS: Record<string, number> = { len: 1, lower: 1, contains: 2, startswith: 2, any: 2 };
const FIELD_PATHS = new Set(FIELDS.map((f) => f.path));

// What the parser and the evaluator throw to unwind from deep in their recursion. compile and eval each catch it once, at
// their edge, and answer with a Result: what's wrong with the expression, or with an item's values for it.
class Bad extends Error {
  readonly pos: number | undefined;
  readonly hint: string | undefined;
  readonly op: string | undefined;
  constructor(message: string, at: { pos?: number; hint?: string; op?: string } = {}) {
    super(message);
    this.pos = at.pos;
    this.hint = at.hint;
    this.op = at.op;
  }
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1,
        s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) throw new Bad(`unterminated string at ${i + 1}`, { pos: i + 1 });
      out.push({ k: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      const op = KEYWORD_OPS[m[0]];
      out.push(op ? { k: "op", v: op, pos: i } : { k: "id", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) {
      out.push({ k: "op", v: two, pos: i });
      i += 2;
      continue;
    }
    if ("!<>+-*/()[],".includes(c)) {
      out.push({ k: "op", v: c, pos: i });
      i++;
      continue;
    }
    if (c === "=") throw new Bad(`use == to compare (at ${i + 1})`, { pos: i + 1 });
    throw new Bad(`unexpected "${c}" at ${i + 1}`, { pos: i + 1 });
  }
  out.push({ k: "end", v: "", pos: src.length });
  return out;
}

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Token => toks[p] ?? { k: "end", v: "", pos: src.length };
  const isOp = (v: string) => peek().k === "op" && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Bad(`expected "${v}" at ${peek().pos + 1}`, { pos: peek().pos + 1 });
    p++;
  };

  const or = (): Node => {
    let a = and();
    while (isOp("||")) {
      p++;
      a = { t: "bin", op: "||", a, b: and() };
    }
    return a;
  };
  const and = (): Node => {
    let a = not();
    while (isOp("&&")) {
      p++;
      a = { t: "bin", op: "&&", a, b: not() };
    }
    return a;
  };
  const not = (): Node => {
    if (isOp("!")) {
      p++;
      return { t: "not", x: not() };
    }
    return cmp();
  };
  const cmp = (): Node => {
    const a = add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">", "in", "matches"]) {
      if (isOp(op)) {
        p++;
        return { t: "bin", op, a, b: add() };
      }
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp("+") || isOp("-")) {
      const op = peek().v;
      p++;
      a = { t: "bin", op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (isOp("*") || isOp("/")) {
      const op = peek().v;
      p++;
      a = { t: "bin", op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp("-")) {
      p++;
      return { t: "neg", x: unary() };
    }
    if (isOp("!")) {
      p++;
      return { t: "not", x: unary() };
    }
    return atom();
  };
  const atom = (): Node => {
    const tok = peek();
    if (tok.k === "num") {
      p++;
      return { t: "lit", v: Number(tok.v) };
    }
    if (tok.k === "str") {
      p++;
      return { t: "lit", v: tok.v };
    }
    if (isOp("(")) {
      p++;
      const x = or();
      expect(")");
      return x;
    }
    if (isOp("[")) {
      p++;
      const items: Node[] = [];
      while (!isOp("]")) {
        items.push(or());
        if (!isOp("]")) expect(",");
      }
      p++;
      return { t: "list", items };
    }
    if (tok.k === "id") {
      p++;
      if (tok.v === "true" || tok.v === "false") return { t: "lit", v: tok.v === "true" };
      if (tok.v === "null") return { t: "lit", v: null };
      if (isOp("(")) {
        p++;
        const args: Node[] = [];
        while (!isOp(")")) {
          args.push(or());
          if (!isOp(")")) expect(",");
        }
        p++;
        return { t: "call", fn: tok.v, args };
      }
      return { t: "name", path: tok.v };
    }
    throw new Bad(tok.k === "end" ? "unexpected end of expression" : `unexpected "${tok.v}" at ${tok.pos + 1}`, { pos: tok.pos + 1 });
  };

  const node = or();
  if (peek().k !== "end") throw new Bad(`unexpected "${peek().v}" at ${peek().pos + 1}`, { pos: peek().pos + 1 });
  return node;
}

function check(node: Node): void {
  switch (node.t) {
    case "lit":
      return;
    case "name":
      if (!FIELD_PATHS.has(node.path)) {
        const hint = suggest(node.path);
        throw new Bad(`unknown field "${node.path}"${hint ? `; did you mean "${hint}"?` : ""}`, hint ? { hint } : {});
      }
      return;
    case "list":
      node.items.forEach(check);
      return;
    case "not":
    case "neg":
      check(node.x);
      return;
    case "bin":
      check(node.a);
      check(node.b);
      if (node.op === "matches" && node.b.t === "lit") {
        const re = regex(String(node.b.v));
        if (Result.isFailure(re)) throw new Bad(`bad regex: ${re.failure}`);
        node.re = re.success;
      }
      return;
    case "call":
      if (!(node.fn in FUNCS)) throw new Bad(`unknown function "${node.fn}"; have ${Object.keys(FUNCS).join(", ")}`);
      if (node.args.length !== FUNCS[node.fn]) throw new Bad(`${node.fn}() takes ${FUNCS[node.fn]} argument(s)`);
      node.args.forEach(check);
  }
}

function suggest(path: string): string | null {
  let best: string | null = null,
    bestD = Infinity;
  for (const f of FIELD_PATHS) {
    const d = distance(path, f);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return bestD <= Math.max(2, Math.floor(path.length / 4)) ? best : null;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(tmp + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

const isValue = (v: unknown): v is Value =>
  v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every(isValue));

// Callers only pass FIELD_PATHS, whose leaves are Values.
function lookup(s: Signals, path: string): Value {
  let v: unknown = s;
  for (const k of path.split(".")) v = field(v, k);
  if (!isValue(v)) throw new Error(`${path} isn't a field's value`);
  return v;
}

function num(v: unknown, op: string): number {
  if (typeof v !== "number") throw new Bad(`${op} needs numbers, got ${JSON.stringify(v)}`, { op });
  return v;
}

// `matches` against what may not be a pattern: a literal is checked when it compiles, a field's value when it's used.
const regex = (source: string): Result.Result<RegExp, string> => Result.try({ try: () => new RegExp(source, "i"), catch: messageOf });

function glob(pattern: string): RegExp {
  return new RegExp(
    "^" +
      pattern
        .split("*")
        .map((p) => p.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  );
}

function evaluate(node: Node, s: Signals): Value {
  switch (node.t) {
    case "lit":
      return node.v;
    case "name":
      return lookup(s, node.path);
    case "list":
      return node.items.map((x) => evaluate(x, s));
    case "not":
      return !evaluate(node.x, s);
    case "neg":
      return -num(evaluate(node.x, s), "-");
    case "call": {
      const args = node.args.map((x) => evaluate(x, s));
      switch (node.fn) {
        case "len":
          return Array.isArray(args[0]) || typeof args[0] === "string" ? args[0].length : 0;
        case "lower":
          return String(args[0] ?? "").toLowerCase();
        case "contains":
          return String(args[0] ?? "")
            .toLowerCase()
            .includes(String(args[1]).toLowerCase());
        case "startswith":
          return String(args[0] ?? "")
            .toLowerCase()
            .startsWith(String(args[1]).toLowerCase());
        case "any": {
          const re = glob(String(args[1]));
          return (Array.isArray(args[0]) ? args[0] : [args[0]]).some((x) => re.test(String(x)));
        }
      }
      throw new Error(`unknown function ${node.fn}`);
    }
    case "bin": {
      if (node.op === "&&") return Boolean(evaluate(node.a, s)) && Boolean(evaluate(node.b, s));
      if (node.op === "||") return Boolean(evaluate(node.a, s)) || Boolean(evaluate(node.b, s));
      const a = evaluate(node.a, s),
        b = evaluate(node.b, s);
      switch (node.op) {
        case "==":
          return a === b;
        case "!=":
          return a !== b;
        case "<":
        case "<=":
        case ">":
        case ">=": {
          if (typeof a === "string" && typeof b === "string") {
            return node.op === "<" ? a < b : node.op === "<=" ? a <= b : node.op === ">" ? a > b : a >= b;
          }
          const x = num(a, node.op),
            y = num(b, node.op);
          return node.op === "<" ? x < y : node.op === "<=" ? x <= y : node.op === ">" ? x > y : x >= y;
        }
        case "in":
          if (Array.isArray(b)) return b.includes(a);
          if (typeof b === "string") return b.includes(String(a));
          throw new Bad(`"in" needs a list or string on the right, got ${JSON.stringify(b)}`, { op: "in" });
        case "matches": {
          if (node.re) return node.re.test(String(a ?? ""));
          const re = regex(String(b));
          if (Result.isFailure(re)) throw new Bad(re.failure, { op: "matches" });
          return re.success.test(String(a ?? ""));
        }
        case "+":
          if (typeof a === "string" || typeof b === "string") return String(a) + String(b);
          return num(a, "+") + num(b, "+");
        case "-":
          return num(a, "-") - num(b, "-");
        case "*":
          return num(a, "*") * num(b, "*");
        case "/":
          return num(a, "/") / num(b, "/");
      }
      throw new Error(`unknown operator ${node.op}`);
    }
  }
  throw new Error("unknown node");
}

// An expression ready to run on an item's signals: its value, or why the item's values don't work with it. Per item, per
// rule, per board on every snapshot, so a Result and never an Effect.
export interface Compiled {
  eval(s: Signals): Result.Result<unknown, ExprEvalError>;
}

export function compile(source: string): Result.Result<Compiled, ExprSyntaxError> {
  return Result.try({
    try: (): Compiled => {
      const node = parse(source);
      check(node);
      return { eval: (s) => Result.try({ try: () => evaluate(node, s), catch: evalError }) };
    },
    catch: (e) => {
      if (e instanceof Bad)
        return new ExprSyntaxError({
          source,
          message: e.message,
          ...(e.pos !== undefined && { pos: e.pos }),
          ...(e.hint !== undefined && { hint: e.hint }),
        });
      if (e instanceof RangeError) return new ExprSyntaxError({ source, message: e.message }); // nested deeper than the stack goes
      throw e; // a bug in the parser, not the expression's
    },
  });
}

function evalError(e: unknown): ExprEvalError {
  if (e instanceof Bad) return new ExprEvalError({ message: e.message, ...(e.op !== undefined && { op: e.op }) });
  if (e instanceof RangeError) return new ExprEvalError({ message: e.message });
  throw e; // an unknown node, function or operator: a bug, since compile checked them
}

// A count of 1 takes the singular of the plural that follows it: "{pr.unresolved_threads} unresolved threads" → "1 unresolved thread".
export function renderTemplate(tpl: string, s: Signals): string {
  return tpl.replaceAll(
    /\{([a-z_]+(?:\.[a-z_0-9]+)+)\}( (?:[a-z]+ )?[a-z]{3,}s\b)?/g,
    (whole: string, path: string, noun: string | undefined) => {
      if (!FIELD_PATHS.has(path)) return whole;
      const v = lookup(s, path);
      if (typeof v === "number") {
        const n = Math.round(v);
        const word = noun ?? "";
        return `${n}${n === 1 && !/(ss|this|does|plus|always)$/.test(word) ? word.slice(0, -1) : word}`;
      }
      if (Array.isArray(v)) return `${andMore(v.map(String))}${noun ?? ""}`;
      return `${String(v ?? "")}${noun ?? ""}`;
    },
  );
}
