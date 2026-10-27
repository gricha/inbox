// A small, safe expression language for rule `when` / `filter` and `why` templates.
import type { Signals } from "./types.ts";
import { FIELDS } from "./signals.ts";

type Node =
  | { t: "lit"; v: unknown }
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

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new SyntaxError(`unterminated string at ${i + 1}`);
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
    if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) { out.push({ k: "op", v: two, pos: i }); i += 2; continue; }
    if ("!<>+-*/()[],".includes(c)) { out.push({ k: "op", v: c, pos: i }); i++; continue; }
    if (c === "=") throw new SyntaxError(`use == to compare (at ${i + 1})`);
    throw new SyntaxError(`unexpected "${c}" at ${i + 1}`);
  }
  out.push({ k: "end", v: "", pos: src.length });
  return out;
}

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().k === "op" && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new SyntaxError(`expected "${v}" at ${peek().pos + 1}`);
    p++;
  };

  const or = (): Node => {
    let a = and();
    while (isOp("||")) { p++; a = { t: "bin", op: "||", a, b: and() }; }
    return a;
  };
  const and = (): Node => {
    let a = not();
    while (isOp("&&")) { p++; a = { t: "bin", op: "&&", a, b: not() }; }
    return a;
  };
  const not = (): Node => {
    if (isOp("!")) { p++; return { t: "not", x: not() }; }
    return cmp();
  };
  const cmp = (): Node => {
    const a = add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">", "in", "matches"]) {
      if (isOp(op)) { p++; return { t: "bin", op, a, b: add() }; }
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp("+") || isOp("-")) { const op = toks[p++].v; a = { t: "bin", op, a, b: mul() }; }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (isOp("*") || isOp("/")) { const op = toks[p++].v; a = { t: "bin", op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => {
    if (isOp("-")) { p++; return { t: "neg", x: unary() }; }
    if (isOp("!")) { p++; return { t: "not", x: unary() }; }
    return atom();
  };
  const atom = (): Node => {
    const tok = peek();
    if (tok.k === "num") { p++; return { t: "lit", v: Number(tok.v) }; }
    if (tok.k === "str") { p++; return { t: "lit", v: tok.v }; }
    if (isOp("(")) { p++; const x = or(); expect(")"); return x; }
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
    throw new SyntaxError(tok.k === "end" ? "unexpected end of expression" : `unexpected "${tok.v}" at ${tok.pos + 1}`);
  };

  const node = or();
  if (peek().k !== "end") throw new SyntaxError(`unexpected "${peek().v}" at ${peek().pos + 1}`);
  return node;
}

function check(node: Node): void {
  switch (node.t) {
    case "name":
      if (!FIELD_PATHS.has(node.path)) {
        const hint = suggest(node.path);
        throw new SyntaxError(`unknown field "${node.path}"${hint ? `; did you mean "${hint}"?` : ""}`);
      }
      return;
    case "list": node.items.forEach(check); return;
    case "not": case "neg": check(node.x); return;
    case "bin":
      check(node.a);
      check(node.b);
      if (node.op === "matches" && node.b.t === "lit") {
        try { node.re = new RegExp(String(node.b.v), "i"); } catch (e) { throw new SyntaxError(`bad regex: ${(e as Error).message}`); }
      }
      return;
    case "call":
      if (!(node.fn in FUNCS)) throw new SyntaxError(`unknown function "${node.fn}"; have ${Object.keys(FUNCS).join(", ")}`);
      if (node.args.length !== FUNCS[node.fn]) throw new SyntaxError(`${node.fn}() takes ${FUNCS[node.fn]} argument(s)`);
      node.args.forEach(check);
      return;
  }
}

function suggest(path: string): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const f of FIELD_PATHS) {
    const d = distance(path, f);
    if (d < bestD) { bestD = d; best = f; }
  }
  return bestD <= Math.max(2, Math.floor(path.length / 4)) ? best : null;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

export function lookup(s: Signals, path: string): unknown {
  let v: unknown = s;
  for (const k of path.split(".")) v = (v as Record<string, unknown> | undefined)?.[k];
  return v;
}

function num(v: unknown, op: string): number {
  if (typeof v !== "number") throw new TypeError(`${op} needs numbers, got ${JSON.stringify(v)}`);
  return v;
}

function glob(pattern: string): RegExp {
  return new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
}

function evaluate(node: Node, s: Signals): unknown {
  switch (node.t) {
    case "lit": return node.v;
    case "name": return lookup(s, node.path);
    case "list": return node.items.map((x) => evaluate(x, s));
    case "not": return !evaluate(node.x, s);
    case "neg": return -num(evaluate(node.x, s), "-");
    case "call": {
      const args = node.args.map((x) => evaluate(x, s));
      switch (node.fn) {
        case "len": return Array.isArray(args[0]) || typeof args[0] === "string" ? args[0].length : 0;
        case "lower": return String(args[0] ?? "").toLowerCase();
        case "contains": return String(args[0] ?? "").toLowerCase().includes(String(args[1]).toLowerCase());
        case "startswith": return String(args[0] ?? "").toLowerCase().startsWith(String(args[1]).toLowerCase());
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
      const a = evaluate(node.a, s), b = evaluate(node.b, s);
      switch (node.op) {
        case "==": return a === b;
        case "!=": return a !== b;
        case "<": case "<=": case ">": case ">=": {
          if (typeof a === "string" && typeof b === "string") {
            return node.op === "<" ? a < b : node.op === "<=" ? a <= b : node.op === ">" ? a > b : a >= b;
          }
          const x = num(a, node.op), y = num(b, node.op);
          return node.op === "<" ? x < y : node.op === "<=" ? x <= y : node.op === ">" ? x > y : x >= y;
        }
        case "in":
          if (Array.isArray(b)) return b.includes(a);
          if (typeof b === "string") return b.includes(String(a));
          throw new TypeError(`"in" needs a list or string on the right, got ${JSON.stringify(b)}`);
        case "matches": return (node.re ?? new RegExp(String(b), "i")).test(String(a ?? ""));
        case "+":
          if (typeof a === "string" || typeof b === "string") return String(a) + String(b);
          return num(a, "+") + num(b, "+");
        case "-": return num(a, "-") - num(b, "-");
        case "*": return num(a, "*") * num(b, "*");
        case "/": return num(a, "/") / num(b, "/");
      }
      throw new Error(`unknown operator ${node.op}`);
    }
  }
}

export type Compiled = { ok: true; eval(s: Signals): unknown } | { ok: false; error: string };

export function compile(src: string): Compiled {
  try {
    const node = parse(src);
    check(node);
    return { ok: true, eval: (s) => evaluate(node, s) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function renderTemplate(tpl: string, s: Signals): string {
  return tpl.replace(/\{([a-z_]+(?:\.[a-z_0-9]+)+)\}/g, (whole, path: string) => {
    if (!FIELD_PATHS.has(path)) return whole;
    const v = lookup(s, path);
    if (typeof v === "number") return String(Math.round(v));
    if (Array.isArray(v)) return v.join(", ");
    return String(v ?? "");
  });
}
