/* Formula rows: "=[TI-101] - [TI-201]" read into a tree.

   The browser reads formulas to draw them as blocks, to know which tags they
   use, and to say what is wrong with one while it is being typed. Computing
   them is the server's job (calc/ in Python), which reads the same grammar:
   tests/fixtures/formula_cases.json holds both parsers to the same answers.

   Hand-written rather than eval(): the text comes from a field the user is
   still typing in, so half an expression has to come back as a message with a
   position in it, not as an exception from somewhere inside the browser. */

// The "=" convention is the spreadsheet one, and no IP21 tag name contains it.
export function isFormula(name) {
  return typeof name === "string" && name.trimStart().startsWith("=");
}

// Functions an expression may call, in the order the "unknown function"
// message lists them (calc/parser.py lists them the same way). The block
// editor offers every one and needs to know which take several inputs.
export const FUNCTION_NAMES = [
  "abs", "sqrt", "ln", "log10", "exp", "round", "min", "max", "avg", "total",
];
const MULTI = new Set(["min", "max", "avg"]);
export function takesMany(name) { return MULTI.has(name); }

// total(expression, period): the expression read as a rate per hour, summed
// over each calendar period - m3/h becomes m3 per day, a comparison (1 or 0)
// becomes hours per day. The period is a word, not a tag.
export const PERIODS = ["hour", "day", "week", "month", "year"];
const PERIOD_LIST = "hour, day, week, month or year";
// An optional third word: how finely the expression inside is read, as
// averages over that interval. Every one divides an hour. auto (the same as
// leaving it out) lets the server pick the finest a long window allows.
export const RESOLUTIONS = ["1min", "5min", "15min", "1h", "auto"];
const RESOLUTION_LIST = "1min, 5min, 15min, 1h or auto";

// Comparisons give 1 or 0, and bind loosest of all: [A] + 1 > [B] compares
// the sum. Two in a row is not a thing a formula needs, so it is an error.
const COMPARE = [">=", "<=", ">", "<"];

// Sticky, so the tokenizer can match at a position rather than search from it.
const NUM_AT = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// A bare name may contain hyphens, because every other IP21 tag does: that
// makes "=TI-101-TI-201" one name rather than a subtraction, which is what the
// brackets are for. A reference that does not exist says so by name, and the
// server's resolve_hint() spells the rest out.
const NAME_AT = /[A-Za-z_][\w.-]*(?:;[\w.\- ]*)?/y;

function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") { i += 1; continue; }
    if (c === "[") {
      const end = text.indexOf("]", i);
      if (end < 0) throw new Error(`missing "]" after position ${i + 1}`);
      const ref = text.slice(i + 1, end).trim();
      if (!ref) throw new Error(`empty [] at ${i + 1}`);
      out.push({ t: "ref", v: ref, i, bracketed: true });
      i = end + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === ">=" || two === "<=") { out.push({ t: two, v: two, i }); i += 2; continue; }
    if ("+-*/^(),<>".includes(c)) { out.push({ t: c, v: c, i }); i += 1; continue; }
    NUM_AT.lastIndex = i;
    const num = NUM_AT.exec(text);
    if (num) { out.push({ t: "num", v: num[0], i }); i += num[0].length; continue; }
    NAME_AT.lastIndex = i;
    const name = NAME_AT.exec(text);
    if (name) { out.push({ t: "name", v: name[0], i }); i += name[0].length; continue; }
    throw new Error(`unexpected "${c}" at ${i + 1}`);
  }
  return out;
}

function peek(p) { return p.tokens[p.i]; }

function eat(p, type) {
  const token = peek(p);
  if (!token || token.t !== type) {
    const where = token ? `at ${token.i + 1}` : "at the end";
    throw new Error(`expected "${type}" ${where}`);
  }
  p.i += 1;
  return token;
}

function parseCompare(p) {
  const node = parseExpr(p);
  const next = peek(p);
  if (next && COMPARE.includes(next.t)) {
    p.i += 1;
    return { k: "bin", op: next.t, a: node, b: parseExpr(p) };
  }
  return node;
}

function parseExpr(p) {
  let node = parseTerm(p);
  while (peek(p) && (peek(p).t === "+" || peek(p).t === "-")) {
    const op = p.tokens[p.i++].t;
    node = { k: "bin", op, a: node, b: parseTerm(p) };
  }
  return node;
}

function parseTerm(p) {
  let node = parsePower(p);
  while (peek(p) && (peek(p).t === "*" || peek(p).t === "/")) {
    const op = p.tokens[p.i++].t;
    node = { k: "bin", op, a: node, b: parsePower(p) };
  }
  return node;
}

// Right-associative, as everywhere else that writes powers: 2^3^2 is 512.
function parsePower(p) {
  const base = parseUnary(p);
  if (peek(p) && peek(p).t === "^") {
    p.i += 1;
    return { k: "bin", op: "^", a: base, b: parsePower(p) };
  }
  return base;
}

function parseUnary(p) {
  const token = peek(p);
  if (token && (token.t === "-" || token.t === "+")) {
    p.i += 1;
    const inner = parseUnary(p);
    return token.t === "-" ? { k: "neg", a: inner } : inner;
  }
  return parsePrimary(p);
}

function parsePrimary(p) {
  const token = peek(p);
  if (!token) throw new Error("the expression ends too early");
  if (token.t === "num") { p.i += 1; return { k: "num", v: parseFloat(token.v) }; }
  if (token.t === "ref") { p.i += 1; return { k: "ref", ref: token.v, bare: false }; }
  if (token.t === "(") {
    p.i += 1;
    const node = parseCompare(p);
    eat(p, ")");
    return node;
  }
  if (token.t === "name") {
    p.i += 1;
    const next = peek(p);
    // A name followed by "(" is a call; anything else is a tag.
    if (!next || next.t !== "(") return { k: "ref", ref: token.v, bare: true };
    if (!FUNCTION_NAMES.includes(token.v)) {
      throw new Error(`unknown function "${token.v}" - try ${FUNCTION_NAMES.join(", ")}`);
    }
    p.i += 1;
    if (token.v === "total") return parseTotal(p);
    const args = [parseCompare(p)];
    while (peek(p) && peek(p).t === ",") { p.i += 1; args.push(parseCompare(p)); }
    eat(p, ")");
    if (args.length > 1 && !MULTI.has(token.v)) {
      throw new Error(`${token.v}() takes one argument`);
    }
    return { k: "fn", name: token.v, args };
  }
  throw new Error(`unexpected "${token.v}" at ${token.i + 1}`);
}

// After "total(": the expression, a comma, a period word, and optionally a
// comma and a resolution - which the tokenizer has split into a number and a
// name ("1min"), so it is read back as the text of its tokens.
function parseTotal(p) {
  const arg = parseCompare(p);
  const comma = peek(p);
  if (!comma || comma.t !== ",") throw new Error(`total() needs a period: ${PERIOD_LIST}`);
  p.i += 1;
  const word = peek(p);
  if (!word || word.t !== "name" || !PERIODS.includes(word.v)) {
    const said = word ? `"${word.v}"` : "nothing";
    throw new Error(`${said} is not a period - use ${PERIOD_LIST}`);
  }
  p.i += 1;
  const node = { k: "fn", name: "total", args: [arg], period: word.v };
  if (peek(p) && peek(p).t === ",") {
    p.i += 1;
    let said = "";
    while (peek(p) && peek(p).t !== ")" && peek(p).t !== ",") said += p.tokens[p.i++].v;
    if (!RESOLUTIONS.includes(said)) {
      throw new Error(`${said ? `"${said}"` : "nothing"} is not a resolution - use ${RESOLUTION_LIST}`);
    }
    if (said !== "auto") node.resolution = said;
  }
  eat(p, ")");
  return node;
}

function collectRefs(node, out, bare) {
  if (node.k === "ref") {
    if (!out.includes(node.ref)) out.push(node.ref);
    if (node.bare) bare.add(node.ref);
    return;
  }
  if (node.k === "neg") collectRefs(node.a, out, bare);
  else if (node.k === "bin") { collectRefs(node.a, out, bare); collectRefs(node.b, out, bare); }
  else if (node.k === "fn") for (const arg of node.args) collectRefs(arg, out, bare);
}

// Throws an Error whose message is meant to be read in the row that caused it.
export function parseFormula(text) {
  const body = String(text).trim().replace(/^=/, "");
  if (!body.trim()) throw new Error("empty formula");
  const p = { tokens: tokenize(body), i: 0 };
  const node = parseCompare(p);
  const left = peek(p);
  if (left) throw new Error(`unexpected "${left.v}" at ${left.i + 1}`);
  const refs = [];
  const bare = new Set();
  collectRefs(node, refs, bare);
  // A row of numbers has no time base to draw against; it needs a tag to
  // borrow one from.
  if (!refs.length) throw new Error("a formula needs at least one tag, e.g. =[TI-101] * 2");
  return { node, refs, bare };
}
