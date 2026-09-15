"""Static checks on the frontend's ES modules.

The frontend has no build step, so nothing resolves imports before a browser
does - and a browser only complains about a missing import when the code that
needs it runs. A forgotten import in the CSV export would surface the first
time someone exported. These tests read the modules as text and catch that
class of mistake without a browser.

The JavaScript is not parsed, only scanned: comments, strings, regex literals
and template text are blanked out, and declarations are recognised by the
house style of writing them at column 0. That is enough because the checks
only ever look at top-level names.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Dict, List, Set

import pytest

STATIC = Path(__file__).resolve().parents[1] / "src" / "ip21_explorer" / "static"

# A "/" after one of these starts a regex literal rather than a division.
REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^")


def strip_literals(src: str) -> str:
    """Blank out comments, strings, regex literals and template text.

    Code inside ${...} is kept. Every other character becomes a space and every
    newline stays, so offsets and line numbers still match the source.
    """
    out: List[str] = []
    i, n = 0, len(src)
    templates: List[int] = []  # brace depth inside each open ${ ... }
    prev, prev_word = "", ""

    def blank(text: str) -> None:
        out.append(re.sub(r"[^\n]", " ", text))

    def template_text(start: int) -> int:
        """Blank template text from start; return the index after it."""
        j = start
        while j < n and src[j] != "`" and not src.startswith("${", j):
            j += 2 if src[j] == "\\" else 1
        blank(src[start:j])
        if j < n and src[j] == "`":
            out.append(" ")
            return j + 1
        out.append("  ")
        templates.append(0)
        return j + 2

    while i < n:
        c = src[i]
        if templates and c == "}" and templates[-1] == 0:
            templates.pop()
            out.append(" ")
            i = template_text(i + 1)
            prev = "x"
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            blank(src[i:j])
            i = j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            blank(src[i:j])
            i = j
            continue
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            blank(src[i:j + 1])
            i, prev = j + 1, "x"
            continue
        if c == "`":
            out.append(" ")
            i, prev = template_text(i + 1), "x"
            continue
        if c == "/" and (prev in REGEX_PREV or prev == "" or
                         prev_word in ("return", "typeof", "case")):
            j, in_class = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            blank(src[i:j])
            i, prev = j, "x"
            continue
        if templates:
            if c == "{":
                templates[-1] += 1
            elif c == "}":
                templates[-1] -= 1
        if c.isalnum() or c in "_$":
            word = re.match(r"[\w$]+", src[i:]).group(0)
            out.append(word)
            i += len(word)
            prev, prev_word = "x", word
            continue
        out.append(c)
        if not c.isspace():
            prev, prev_word = c, ""
        i += 1
    return "".join(out)


TOP_DECL = re.compile(
    r"^(export\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|(?:const|let|var|class)\s+([\w$]+))",
    re.M,
)
IMPORT = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*[\"']([^\"']+)[\"']\s*;?", re.M)
EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\}\s*;?", re.M)
IDENT = re.compile(r"(?<![\w$.])[A-Za-z_$][\w$]*")
LOCAL_DECL = re.compile(r"(?<![\w$.])(?:let|const|var)\s+([\w$]+)")
PARAM_LISTS = [
    re.compile(r"function\s*\*?\s*[\w$]*\s*\(([^)]*)\)"),
    re.compile(r"\(([^()]*)\)\s*=>"),
    re.compile(r"(?<![\w$.])([\w$]+)\s*=>"),
    re.compile(r"(?<![\w$.])(?:let|const|var)\s*[\[{]([^\]}=]*)[\]}]"),
    re.compile(r"catch\s*\(\s*([\w$]+)"),
]


def _blank_match(code: str, m: "re.Match[str]") -> str:
    return code[:m.start()] + re.sub(r"[^\n]", " ", m.group(0)) + code[m.end():]


def _local_name(spec: str) -> str:
    """'a' -> 'a', 'a as b' -> 'b'."""
    return spec.split(" as ")[-1].strip()


class Module:
    def __init__(self, path: Path):
        self.name = path.relative_to(STATIC).as_posix()
        source = path.read_text(encoding="utf-8")
        code = strip_literals(source)

        # Import statements are read from the source (their paths are strings)
        # and then blanked, so the names they list do not count as uses.
        self.imports: Dict[str, Set[str]] = {}
        for m in IMPORT.finditer(source):
            names = {_local_name(p) for p in m.group(1).split(",") if p.strip()}
            self.imports.setdefault(m.group(2), set()).update(names)
            code = _blank_match(code, m)
        self.imported: Set[str] = set().union(*self.imports.values())

        self.exports: Set[str] = set()
        self.declared: Dict[str, int] = {}
        for m in TOP_DECL.finditer(code):
            name = m.group(2) or m.group(3)
            self.declared[name] = code.count("\n", 0, m.start()) + 1
            if m.group(1):
                self.exports.add(name)
        for m in EXPORT_LIST.finditer(code):
            self.exports.update(_local_name(p) for p in m.group(1).split(",") if p.strip())
            code = _blank_match(code, m)

        self.locals: Set[str] = set()
        for m in LOCAL_DECL.finditer(code):
            if m.start() != code.rfind("\n", 0, m.start()) + 1:  # not column 0
                self.locals.add(m.group(1))
        for pattern in PARAM_LISTS:
            for m in pattern.finditer(code):
                for part in re.split(r"[,\s=.{}\[\]:]+", m.group(1)):
                    if re.fullmatch(r"[A-Za-z_$][\w$]*", part):
                        self.locals.add(part)

        self.used: Dict[str, int] = {}
        for m in IDENT.finditer(code):
            self.used.setdefault(m.group(0), code.count("\n", 0, m.start()) + 1)


def load_modules() -> Dict[str, Module]:
    found = (Module(p) for p in sorted(STATIC.rglob("*.js")))
    return {m.name: m for m in found if not m.name.startswith("vendor/")}


def resolve(importer: Module, spec: str) -> str:
    path = Path(importer.name).parent / spec
    return re.sub(r"^(\./)+", "", path.as_posix())


def entry_script() -> str:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    scripts = re.findall(r"<script\b[^>]*\bsrc=\"([^\"]+)\"", html)
    assert len(scripts) == 2 and scripts[0].startswith("vendor/uplot"), (
        f"expected uPlot and one entry script, got {scripts}"
    )
    return scripts[1]


@pytest.fixture(scope="module")
def modules():
    return load_modules()


def test_imports_resolve_to_exported_names(modules):
    problems = []
    for mod in modules.values():
        for spec, names in mod.imports.items():
            target = modules.get(resolve(mod, spec))
            if target is None:
                problems.append(f"{mod.name}: imports from missing {spec}")
                continue
            for name in sorted(names - target.exports):
                problems.append(f"{mod.name}: {name} is not exported by {target.name}")
    assert not problems, "\n".join(problems)


def test_no_name_is_declared_in_two_modules(modules):
    owners: Dict[str, List[str]] = {}
    for mod in modules.values():
        for name in mod.declared:
            owners.setdefault(name, []).append(mod.name)
    clashes = {n: o for n, o in owners.items() if len(o) > 1}
    assert not clashes, clashes


def test_names_from_other_modules_are_imported(modules):
    """The check that stands in for a bundler: a top-level name from another
    module, used without an import, fails here instead of in front of a user."""
    owners = {name: mod.name for mod in modules.values() for name in mod.declared}
    problems = []
    for mod in modules.values():
        for name, line in sorted(mod.used.items(), key=lambda kv: kv[1]):
            owner = owners.get(name)
            if owner is None or owner == mod.name or name in mod.imported:
                continue
            if name in mod.locals:
                problems.append(
                    f"{mod.name}:{line}: {name} is a local here but a top-level name in "
                    f"{owner} - rename the local so a missing import cannot hide behind it"
                )
            else:
                problems.append(f"{mod.name}:{line}: uses {name} from {owner} without importing it")
    assert not problems, "\n".join(problems)


def test_imported_names_are_used(modules):
    problems = [
        f"{mod.name}: imports {name} but never uses it"
        for mod in modules.values()
        for name in sorted(mod.imported - set(mod.used))
    ]
    assert not problems, "\n".join(problems)


def test_every_module_is_reachable_from_the_entry(modules):
    entry = entry_script()
    assert entry in modules, f"index.html loads {entry}, which does not exist"
    seen, todo = set(), [entry]
    while todo:
        name = todo.pop()
        if name in seen or name not in modules:
            continue
        seen.add(name)
        todo.extend(resolve(modules[name], spec) for spec in modules[name].imports)
    orphans = sorted(set(modules) - seen)
    assert not orphans, f"modules nothing imports: {orphans}"


def test_scanner_blanks_literals_but_keeps_template_code():
    src = 'const a = "x // y"; /* b */ const r = /[/"]+/g; const t = `k ${ f(`${g}`) } z`; // c\n'
    code = strip_literals(src)
    assert len(code) == len(src)
    words = re.findall(r"[A-Za-z_$][\w$]*", code)
    assert words == ["const", "a", "const", "r", "const", "t", "f", "g"]


def test_scanner_catches_a_missing_import(tmp_path, monkeypatch):
    """Guard the guard: two modules where one forgets an import must fail."""
    (tmp_path / "index.html").write_text(
        '<script src="vendor/uplot.iife.min.js"></script>'
        '<script type="module" src="main.js"></script>'
    )
    (tmp_path / "util.js").write_text("export function helper() { return 1; }\n")
    (tmp_path / "main.js").write_text(
        'import { helper } from "./util.js";\n'
        "function run(x) { return helper() + other(x); }\n"
        "run(1);\n"
    )
    (tmp_path / "other.js").write_text("export function other(v) { return v; }\n")
    monkeypatch.setattr(sys.modules[__name__], "STATIC", tmp_path)
    mods = load_modules()
    with pytest.raises(AssertionError, match="uses other from other.js without importing it"):
        test_names_from_other_modules_are_imported(mods)
    with pytest.raises(AssertionError, match="other.js"):
        test_every_module_is_reachable_from_the_entry(mods)
