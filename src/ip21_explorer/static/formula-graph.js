/* Formulas as blocks and wires: the same expression as the text, drawn.

   The text in the Tag field stays the truth. A graph is made from it when the
   block editor opens, and turned back into text when it closes, so nothing
   downstream - fetching, computing, saving - knows blocks exist. Pure: it
   imports only the parser. */

import { PERIODS, parseFormula, takesMany } from "./formula.js";

// Node types: tag {ref}, num {value}, op {op}, neg, fn {name, period?}, out.
// A total block is fn {name: "total", period: "day"}.
// Wires: {from, to, port} - the output of `from` into input `port` of `to`.
// An output may feed any number of inputs; an input takes one wire at most.

const COLUMN_W = 190;
const ROW_H = 78;

export function emptyGraph() {
  return { nodes: [{ id: "out", type: "out", x: 0, y: 0 }], wires: [], seq: 0 };
}

export function newNode(graph, fields) {
  graph.seq += 1;
  const node = { id: `n${graph.seq}`, x: 0, y: 0, ...fields };
  graph.nodes.push(node);
  return node;
}

// + and * are associative, and so are min, max and avg: any number of inputs.
// Minus, divide and power are not, and keep exactly two.
export function isVariadic(node) {
  return (node.type === "op" && (node.op === "+" || node.op === "*")) ||
    (node.type === "fn" && takesMany(node.name));
}

// Inputs on show: fixed for most blocks; for the variadic ones, every wired
// input plus one spare to wire the next into, and never fewer than two.
export function inputPorts(graph, node) {
  if (node.type === "tag" || node.type === "num") return 0;
  if (node.type === "neg" || node.type === "out") return 1;
  if (node.type === "fn" && !takesMany(node.name)) return 1;
  if (!isVariadic(node)) return 2;
  const used = graph.wires.filter((w) => w.to === node.id).map((w) => w.port);
  return Math.max(2, (used.length ? Math.max(...used) + 1 : 0) + 1);
}

const OP_SIGNS = {
  "+": "+", "-": "−", "*": "×", "/": "÷", "^": "^", ">": ">", "<": "<", ">=": "≥", "<=": "≤",
};

export function nodeLabel(node) {
  if (node.type === "tag") return node.ref || "tag";
  if (node.type === "num") return String(node.value);
  if (node.type === "op") return OP_SIGNS[node.op] || node.op;
  if (node.type === "neg") return "−x";
  if (node.type === "fn") return node.name;
  return "Result";
}


// -- text -> graph -----------------------------------------------------------

// One block per distinct tag, fed to every place that uses it, and a chain of
// the same + or * (the parser nests "a + b + c" as ((a + b) + c)) as one block
// with an input each - which is how anyone would draw it.
export function graphFromText(text) {
  const { node: ast } = parseFormula(text);
  const graph = emptyGraph();
  const tagNodes = new Map();

  const build = (tree) => {
    if (tree.k === "num") return newNode(graph, { type: "num", value: tree.v }).id;
    if (tree.k === "ref") {
      if (!tagNodes.has(tree.ref)) {
        tagNodes.set(tree.ref, newNode(graph, { type: "tag", ref: tree.ref }).id);
      }
      return tagNodes.get(tree.ref);
    }
    if (tree.k === "neg") {
      const node = newNode(graph, { type: "neg" });
      graph.wires.push({ from: build(tree.a), to: node.id, port: 0 });
      return node.id;
    }
    if (tree.k === "fn") {
      const fields = { type: "fn", name: tree.name };
      if (tree.period) fields.period = tree.period;
      const node = newNode(graph, fields);
      tree.args.forEach((arg, i) => graph.wires.push({ from: build(arg), to: node.id, port: i }));
      return node.id;
    }
    // bin
    const node = newNode(graph, { type: "op", op: tree.op });
    let operands = [tree.a, tree.b];
    if (tree.op === "+" || tree.op === "*") {
      // Unwind the left spine only: a + (b + c) was bracketed on purpose.
      operands = [tree.b];
      let left = tree.a;
      while (left.k === "bin" && left.op === tree.op) {
        operands.unshift(left.b);
        left = left.a;
      }
      operands.unshift(left);
    }
    operands.forEach((operand, i) =>
      graph.wires.push({ from: build(operand), to: node.id, port: i }));
    return node.id;
  };

  graph.wires.push({ from: build(ast), to: "out", port: 0 });
  layoutGraph(graph);
  return graph;
}

// -- graph -> tree -> text ---------------------------------------------------

// The expression tree a node stands for, in the parser's own shapes so the
// evaluator can run it. Throws, with a message fit for the error line, when
// the node is not wired up or sits in a loop.
function nodeAst(graph, id, stack = []) {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error("a wire leads nowhere");
  if (stack.includes(id)) throw new Error(`${nodeLabel(node)} feeds itself`);
  const inputs = graph.wires.filter((w) => w.to === id).sort((a, b) => a.port - b.port);
  const sub = (wire) => nodeAst(graph, wire.from, stack.concat(id));
  const need = (count) => {
    for (let port = 0; port < count; port++) {
      if (!inputs.some((w) => w.port === port)) {
        throw new Error(`${nodeLabel(node)} has an empty input`);
      }
    }
  };

  if (node.type === "tag") {
    if (!String(node.ref || "").trim()) throw new Error("a tag block has no name");
    return { k: "ref", ref: String(node.ref).trim(), bare: false };
  }
  if (node.type === "num") {
    const v = Number(node.value);
    if (!Number.isFinite(v)) throw new Error(`${node.value} is not a number`);
    return { k: "num", v };
  }
  if (node.type === "out") {
    if (!inputs.length) throw new Error("nothing is wired to Result");
    return sub(inputs[0]);
  }
  if (node.type === "neg") { need(1); return { k: "neg", a: sub(inputs[0]) }; }
  if (node.type === "fn" && node.name === "total") {
    need(1);
    const period = PERIODS.includes(node.period) ? node.period : "day";
    return { k: "fn", name: "total", args: [sub(inputs[0])], period };
  }
  if (node.type === "fn" && !takesMany(node.name)) {
    need(1);
    return { k: "fn", name: node.name, args: [sub(inputs[0])] };
  }
  if (node.type === "fn") {
    if (!inputs.length) throw new Error(`${node.name} has no inputs`);
    return { k: "fn", name: node.name, args: inputs.map(sub) };
  }
  if (isVariadic(node)) {
    if (inputs.length < 2) throw new Error(`${nodeLabel(node)} needs at least two inputs`);
    return inputs.map(sub).reduce((a, b) => ({ k: "bin", op: node.op, a, b }));
  }
  need(2);
  return { k: "bin", op: node.op, a: sub(inputs[0]), b: sub(inputs[1]) };
}

// Precedence as formula.js parses it: comparisons loosest, and never two in a
// row; unary minus binds tighter than ^, which is right-associative; - and /
// are left-associative.
const PREC = { ">": 0, "<": 0, ">=": 0, "<=": 0, "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };
const PREC_NEG = 4;
const PREC_ATOM = 5;

function emitAst(tree) {
  if (tree.k === "num") {
    const s = String(tree.v);
    return { s, p: tree.v < 0 ? PREC_NEG : PREC_ATOM };
  }
  if (tree.k === "ref") return { s: `[${tree.ref}]`, p: PREC_ATOM };
  if (tree.k === "fn") {
    const args = tree.args.map((a) => emitAst(a).s);
    if (tree.period) args.push(tree.period);
    return { s: `${tree.name}(${args.join(", ")})`, p: PREC_ATOM };
  }
  if (tree.k === "neg") {
    const inner = emitAst(tree.a);
    return { s: `-${inner.p < PREC_ATOM ? `(${inner.s})` : inner.s}`, p: PREC_NEG };
  }
  const p = PREC[tree.op];
  const a = emitAst(tree.a), b = emitAst(tree.b);
  let left, right;
  if (tree.op === "^") {
    left = a.p < PREC_NEG ? `(${a.s})` : a.s;      // base: a unary or an atom
    right = b.p < p ? `(${b.s})` : b.s;            // exponent: may chain
  } else {
    // Comparisons do not chain: one inside another is bracketed either side.
    left = (p === 0 ? a.p <= p : a.p < p) ? `(${a.s})` : a.s;
    // - and / are not associative: a - (b - c) keeps its brackets.
    const strict = tree.op === "-" || tree.op === "/" || p === 0;
    right = (strict ? b.p <= p : b.p < p) ? `(${b.s})` : b.s;
  }
  const sign = tree.op === "^" ? "^" : ` ${tree.op} `;
  return { s: `${left}${sign}${right}`, p };
}

// The text a graph stands for, and what stops it being one - or, given a
// block's id, the text of what that one block computes.
export function textFromGraph(graph, id = "out") {
  try {
    const tree = nodeAst(graph, id);
    const text = `=${emitAst(tree).s}`;
    parseFormula(text); // a graph that cannot be read back is a bug, not a formula
    return { text, errors: [] };
  } catch (err) {
    return { text: "", errors: [err.message] };
  }
}

// -- layout ------------------------------------------------------------------

// Result on the right and everything it depends on in columns leftwards, by
// the longest path to it; within a column, in the order the blocks feed.
export function layoutGraph(graph) {
  const depth = new Map([["out", 0]]);
  let changed = true;
  for (let guard = 0; changed && guard < graph.nodes.length + 2; guard++) {
    changed = false;
    for (const wire of graph.wires) {
      const d = (depth.get(wire.to) ?? -Infinity) + 1;
      if (d > (depth.get(wire.from) ?? -Infinity)) { depth.set(wire.from, d); changed = true; }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const columns = new Map();
  // Unwired blocks go in a column of their own at the far left.
  const order = [...graph.nodes].sort((a, b) =>
    graph.wires.findIndex((w) => w.from === a.id) - graph.wires.findIndex((w) => w.from === b.id));
  for (const node of order) {
    const d = depth.has(node.id) ? depth.get(node.id) : maxDepth + 1;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(node);
  }
  const deepest = Math.max(...columns.keys());
  for (const [d, list] of columns) {
    list.forEach((node, i) => {
      node.x = 24 + (deepest - d) * COLUMN_W;
      node.y = 24 + i * ROW_H + (d === 0 ? ROW_H : 0);
    });
  }
  return graph;
}
