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

// What a formula may call, from /api/functions: our own handful and every
// library function the server can run, each with how many inputs it takes and
// what settings follow them. The server builds it from the same catalog it
// computes with (calc/catalog.py), so the two can never drift apart.
let specs = new Map();
let specGroups = [];

export function setFunctionCatalog(answer) {
  specs = new Map();
  specGroups = (answer && answer.groups) || [];
  for (const group of specGroups) {
    for (const spec of group.functions) specs.set(spec.name, { ...spec, group: group.name });
  }
}

export function functionSpec(name) { return specs.get(name) || null; }
export function functionGroups() { return specGroups; }
export function takesMany(name) {
  const spec = specs.get(name);
  return !!(spec && spec.variadic);
}

// Before the catalog has arrived - and in a tab opened offline - the handful
// of functions the app has always had still parse.
setFunctionCatalog({ groups: [{ name: "Basic", functions: [
  ...["abs", "sqrt", "ln", "log10", "exp", "round"].map((name) =>
    ({ name, inputs: 1, params: [] })),
  ...["min", "max", "avg"].map((name) =>
    ({ name, inputs: 1, variadic: true, params: [] })),
  { name: "total", inputs: 1, params: [
    { name: "period", kind: "choice", default: "day",
      choices: ["hour", "day", "week", "month", "year"] },
    { name: "resolution", kind: "choice", default: "auto",
      choices: ["auto", "1min", "5min", "15min", "1h"] },
  ] },
] }] });

const DURATION_AT = /^(\d+(?:\.\d+)?)(ms|s|min|h|d|w)$/i;
const TRUE_WORDS = ["true", "yes", "on", "1"];
const FALSE_WORDS = ["false", "no", "off", "0"];

// One setting's word to its value, with the same words and the same
// complaints as calc/catalog.py.
export function readWord(spec, param, word) {
  const wrong = (expected) =>
    new Error(`${spec.name}: ${param.name} expects ${expected}, got "${word}"`);
  if (param.kind === "number") {
    const value = Number(word);
    if (word === "" || !Number.isFinite(value)) throw wrong("a number");
    return value;
  }
  if (param.kind === "duration") {
    if (!DURATION_AT.test(word)) throw wrong("a duration like 30min, 4h or 3d");
    return word;
  }
  if (param.kind === "flag") {
    if (TRUE_WORDS.includes(word.toLowerCase())) return true;
    if (FALSE_WORDS.includes(word.toLowerCase())) return false;
    throw wrong("true or false");
  }
  if (param.kind === "choice") {
    if (!param.choices.includes(word)) {
      throw new Error(`${spec.name}: ${param.name} must be one of ${param.choices.join(", ")}`);
    }
    return word;
  }
  return word;
}

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
    const spec = functionSpec(token.v);
    if (!spec) {
      throw new Error(`unknown function "${token.v}" - the block editor's palette `
        + "has the ones there are");
    }
    p.i += 1;
    return parseCall(p, spec);
  }
  throw new Error(`unexpected "${token.v}" at ${token.i + 1}`);
}

// A call: its inputs as expressions, then one word per setting. Settings at
// the end may be left out and keep their defaults.
function parseCall(p, spec) {
  const args = [parseCompare(p)];
  while (spec.variadic && peek(p) && peek(p).t === ",") {
    p.i += 1;
    args.push(parseCompare(p));
  }
  while (args.length < spec.inputs) {
    eat(p, ",");
    args.push(parseCompare(p));
  }
  const params = {};
  for (const param of spec.params || []) {
    if (!(peek(p) && peek(p).t === ",")) {
      // A setting the function has no default for has to be there.
      if (param.required) throw new Error(`${spec.name} needs ${param.name}`);
      break;
    }
    p.i += 1;
    let word = "";
    while (peek(p) && peek(p).t !== ")" && peek(p).t !== ",") word += p.tokens[p.i++].v;
    params[param.name] = readWord(spec, param, word);
  }
  if (peek(p) && peek(p).t === ",") throw new Error(tooMany(spec));
  eat(p, ")");
  return { k: "fn", name: spec.name, args, params };
}

function tooMany(spec) {
  const inputs = spec.variadic ? "any number of inputs"
    : spec.inputs === 1 ? "1 input" : `${spec.inputs} inputs`;
  const count = (spec.params || []).length;
  if (!count) return `${spec.name} takes ${inputs} and no settings`;
  const settings = count === 1 ? "1 setting" : `${count} settings`;
  return `${spec.name} takes ${inputs} and up to ${settings}`;
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
