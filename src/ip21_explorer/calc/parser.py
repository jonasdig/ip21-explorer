"""Formula text into an expression tree: "=[TI-101] - [TI-201]".

The grammar is the one static/formula.js reads while the user types, and the
two must agree: the browser parses to draw blocks and to say what is wrong
with a half-written formula, this side parses to compute it. The trees have
the same shapes, as plain dicts:

    {"k": "num", "v": 2.0}
    {"k": "ref", "ref": "TI-101", "bare": False}
    {"k": "neg", "a": node}
    {"k": "bin", "op": "+", "a": node, "b": node}
    {"k": "fn", "name": "avg", "args": [node, ...], "params": {}}
    {"k": "fn", "name": "total", "args": [node], "params": {"period": "day"}}

Error messages match the browser's word for word, positions included.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

Node = Dict[str, Any]

from .catalog import ArgumentError, FunctionSpec, find, read_word

# Comparisons give 1 or 0 and bind loosest of all; two in a row is an error.
COMPARE = (">=", "<=", ">", "<")

NUM_AT = re.compile(r"\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", re.ASCII)
# A bare name may contain hyphens, because every other IP21 tag does: that
# makes "=TI-101-TI-201" one name rather than a subtraction, which is what the
# brackets are for.
NAME_AT = re.compile(r"[A-Za-z_][\w.-]*(?:;[\w.\- ]*)?", re.ASCII)
SINGLE = "+-*/^(),<>"


class FormulaError(ValueError):
    """A formula that cannot be read; the message is meant for the user."""


@dataclass
class Token:
    t: str      # "num", "ref", "name" or the character itself
    v: str
    i: int      # position in the text after the "=", 0-based


@dataclass
class Parsed:
    node: Node
    refs: List[str]                         # in order of first appearance
    bare: Set[str] = field(default_factory=set)  # refs written without brackets


def is_formula(name: str) -> bool:
    return isinstance(name, str) and name.lstrip().startswith("=")


def tokenize(text: str) -> List[Token]:
    out: List[Token] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c in " \t":
            i += 1
            continue
        if c == "[":
            end = text.find("]", i)
            if end < 0:
                raise FormulaError(f'missing "]" after position {i + 1}')
            ref = text[i + 1:end].strip()
            if not ref:
                raise FormulaError(f"empty [] at {i + 1}")
            out.append(Token("ref", ref, i))
            i = end + 1
            continue
        if text[i:i + 2] in (">=", "<="):
            out.append(Token(text[i:i + 2], text[i:i + 2], i))
            i += 2
            continue
        if c in SINGLE:
            out.append(Token(c, c, i))
            i += 1
            continue
        num = NUM_AT.match(text, i)
        if num:
            out.append(Token("num", num.group(0), i))
            i = num.end()
            continue
        name = NAME_AT.match(text, i)
        if name:
            out.append(Token("name", name.group(0), i))
            i = name.end()
            continue
        raise FormulaError(f'unexpected "{c}" at {i + 1}')
    return out


class _Parser:
    def __init__(self, tokens: List[Token]):
        self.tokens = tokens
        self.i = 0

    def peek(self) -> Optional[Token]:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def eat(self, kind: str) -> Token:
        token = self.peek()
        if token is None or token.t != kind:
            where = f"at {token.i + 1}" if token else "at the end"
            raise FormulaError(f'expected "{kind}" {where}')
        self.i += 1
        return token

    def compare(self) -> Node:
        node = self.expr()
        following = self.peek()
        if following and following.t in COMPARE:
            self.i += 1
            return {"k": "bin", "op": following.t, "a": node, "b": self.expr()}
        return node

    def expr(self) -> Node:
        node = self.term()
        while self.peek() and self.peek().t in "+-":
            op = self.tokens[self.i].t
            self.i += 1
            node = {"k": "bin", "op": op, "a": node, "b": self.term()}
        return node

    def term(self) -> Node:
        node = self.power()
        while self.peek() and self.peek().t in "*/":
            op = self.tokens[self.i].t
            self.i += 1
            node = {"k": "bin", "op": op, "a": node, "b": self.power()}
        return node

    # Right-associative, as everywhere else that writes powers: 2^3^2 is 512.
    def power(self) -> Node:
        base = self.unary()
        if self.peek() and self.peek().t == "^":
            self.i += 1
            return {"k": "bin", "op": "^", "a": base, "b": self.power()}
        return base

    # Binds tighter than ^, as in the browser: -a^2 is (-a)^2.
    def unary(self) -> Node:
        token = self.peek()
        if token and token.t in ("-", "+"):
            self.i += 1
            inner = self.unary()
            return {"k": "neg", "a": inner} if token.t == "-" else inner
        return self.primary()

    # A call: its inputs as expressions, then one word per setting. Settings
    # at the end may be left out and keep their defaults.
    def call(self, spec: FunctionSpec, token: Token) -> Node:
        args = [self.compare()]
        while spec.variadic and self.peek() and self.peek().t == ",":
            self.i += 1
            args.append(self.compare())
        while len(args) < spec.inputs:
            self.eat(",")
            args.append(self.compare())
        params: Dict[str, Any] = {}
        for param in spec.params:
            if not (self.peek() and self.peek().t == ","):
                # A setting the function has no default for has to be there.
                if param.required:
                    raise FormulaError(f"{spec.name} needs {param.name}")
                break
            self.i += 1
            word = ""
            while self.peek() and self.peek().t not in (")", ","):
                word += self.tokens[self.i].v
                self.i += 1
            try:
                params[param.name] = read_word(spec, param, word)
            except ArgumentError as exc:
                raise FormulaError(str(exc)) from None
        if self.peek() and self.peek().t == ",":
            raise FormulaError(_too_many(spec))
        self.eat(")")
        return {"k": "fn", "name": spec.name, "args": args, "params": params}

    def primary(self) -> Node:
        token = self.peek()
        if token is None:
            raise FormulaError("the expression ends too early")
        if token.t == "num":
            self.i += 1
            return {"k": "num", "v": float(token.v)}
        if token.t == "ref":
            self.i += 1
            return {"k": "ref", "ref": token.v, "bare": False}
        if token.t == "(":
            self.i += 1
            node = self.compare()
            self.eat(")")
            return node
        if token.t == "name":
            self.i += 1
            following = self.peek()
            # A name followed by "(" is a call; anything else is a tag.
            if following is None or following.t != "(":
                return {"k": "ref", "ref": token.v, "bare": True}
            spec = find(token.v)
            if spec is None:
                raise FormulaError(
                    f'unknown function "{token.v}" - the block editor\'s palette '
                    "has the ones there are"
                )
            self.i += 1
            return self.call(spec, token)
        raise FormulaError(f'unexpected "{token.v}" at {token.i + 1}')

def _too_many(spec: FunctionSpec) -> str:
    inputs = "any number of inputs" if spec.variadic else (
        "1 input" if spec.inputs == 1 else f"{spec.inputs} inputs")
    if not spec.params:
        return f"{spec.name} takes {inputs} and no settings"
    settings = "1 setting" if len(spec.params) == 1 else f"{len(spec.params)} settings"
    return f"{spec.name} takes {inputs} and up to {settings}"


def _collect_refs(node: Node, out: List[str], bare: Set[str]) -> None:
    kind = node["k"]
    if kind == "ref":
        if node["ref"] not in out:
            out.append(node["ref"])
        if node["bare"]:
            bare.add(node["ref"])
    elif kind == "neg":
        _collect_refs(node["a"], out, bare)
    elif kind == "bin":
        _collect_refs(node["a"], out, bare)
        _collect_refs(node["b"], out, bare)
    elif kind == "fn":
        for arg in node["args"]:
            _collect_refs(arg, out, bare)


def parse_formula(text: str) -> Parsed:
    """Read a formula; raises FormulaError with a message for the user."""
    body = re.sub(r"^=", "", str(text).strip())
    if not body.strip():
        raise FormulaError("empty formula")
    parser = _Parser(tokenize(body))
    node = parser.compare()
    left = parser.peek()
    if left is not None:
        raise FormulaError(f'unexpected "{left.v}" at {left.i + 1}')
    refs: List[str] = []
    bare: Set[str] = set()
    _collect_refs(node, refs, bare)
    # A row of numbers has no time base to draw against; it needs a tag to
    # borrow one from.
    if not refs:
        raise FormulaError("a formula needs at least one tag, e.g. =[TI-101] * 2")
    return Parsed(node, refs, bare)


def resolve_hint(ref: str, was_bare: bool) -> str:
    """The subtraction a bare hyphenated name that does not exist probably was."""
    if not was_bare:
        return ""
    parts = [p for p in ref.split("-") if p]
    if len(parts) < 2:
        return ""
    return " - to subtract, write [" + "] - [".join(parts) + "]"
