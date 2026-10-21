#!/usr/bin/env python3
"""Builds the whole game into one HTML file you can double-click.

    python bundle.py

The normal way to run SKYLINE is to serve the folder, because a browser
will not load ES modules over file:// -- which makes the game useless on a
machine where you cannot install Python or reach a web host. An inline
<script type="module"> is not fetched, though, so it is allowed. Flatten
the forty-odd modules into one of those, inline the stylesheet, and the
whole game becomes a file that runs off a USB stick with nothing installed.

This is a very small bundler and it only has to handle the syntax this
codebase actually uses, which the asserts below pin down: named and
namespace imports, named exports, one dynamic import, no `export default`,
no `export *`, no live-binding `export let`. If someone writes one of those
later, the build fails loudly rather than emitting a broken game.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ENTRY = 'src/main.js'
BARE = {'three': 'vendor/three/three.module.js'}
OUT = 'SKYLINE.html'

# --- the shapes we accept -------------------------------------------------
RE_NS = re.compile(r"^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+)';?\s*$")
RE_NAMED = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?\s*$", re.S)
RE_EXP_DECL = re.compile(
    r"^export\s+(?:(const|let|var)\s+([A-Za-z_$][\w$]*)"
    r"|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"
    r"|class\s+([A-Za-z_$][\w$]*))")
RE_EXP_LIST = re.compile(r"^export\s*\{([^}]*)\}\s*;?\s*$", re.S)
RE_DYNAMIC = re.compile(r"import\(\s*'([^']+)'\s*\)")
RE_BANNED = re.compile(r"^export\s+(default|\*)")


def rel(path):
    return os.path.relpath(path, ROOT).replace('\\', '/')


def resolve(spec, importer):
    if spec in BARE:
        return BARE[spec]
    base = os.path.dirname(os.path.join(ROOT, importer))
    return rel(os.path.normpath(os.path.join(base, spec)))


def read(mod):
    with open(os.path.join(ROOT, mod), encoding='utf-8') as f:
        return f.read()


def statements(src):
    """Yields (start, end, text) for every top-level import/export block.

    Line based, because that is how this codebase is written and a real
    parser is four hundred lines I do not need. A block that opens with
    `{` and does not close on its own line is joined with the ones that
    follow until it does.
    """
    lines = src.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('import') or line.startswith('export'):
            if RE_BANNED.match(line):
                raise SystemExit(f'bundle.py cannot handle: {line.strip()}')
            block, j = line, i
            # join continuation lines until the braces balance
            while block.count('{') > block.count('}') and j + 1 < len(lines):
                j += 1
                block += '\n' + lines[j]
            yield i, j, block
            i = j + 1
        else:
            i += 1


def names(spec_list):
    """`a, b as c` -> [(imported, local), ...]"""
    out = []
    for part in spec_list.split(','):
        part = part.strip()
        if not part:
            continue
        if ' as ' in part:
            a, b = part.split(' as ')
            out.append((a.strip(), b.strip()))
        else:
            out.append((part, part))
    return out


def transform(mod):
    """Rewrites one module's source into a function body, and reports deps."""
    src = read(mod)
    lines = src.split('\n')
    deps = []
    exports = []            # (exported name, local name)
    drop = {}               # line index -> replacement text

    for start, end, block in statements(src):
        m = RE_NS.match(block)
        if m:
            local, spec = m.group(1), m.group(2)
            dep = resolve(spec, mod)
            deps.append(dep)
            drop[start] = f"const {local} = __req({dep!r});"
        else:
            m = RE_NAMED.match(block)
            if m:
                dep = resolve(m.group(2), mod)
                deps.append(dep)
                pairs = ', '.join(
                    a if a == b else f'{a}: {b}' for a, b in names(m.group(1)))
                drop[start] = f"const {{ {pairs} }} = __req({dep!r});"
            else:
                m = RE_EXP_LIST.match(block)
                if m:
                    # `export { a as b }` publishes local a under the name b
                    exports += [(b, a) for a, b in names(m.group(1))]
                    drop[start] = ''
                else:
                    m = RE_EXP_DECL.match(block)
                    if not m:
                        raise SystemExit(
                            f'{mod}: unrecognised statement:\n{block[:120]}')
                    name = m.group(2) or m.group(3) or m.group(4)
                    exports.append((name, name))
                    # keep the declaration, lose the `export ` in front
                    drop[start] = block[len('export '):].split('\n')[0]
                    for k in range(start + 1, end + 1):
                        drop[k] = lines[k]
        for k in range(start, end + 1):
            drop.setdefault(k, '')

    body = [drop.get(i, line) for i, line in enumerate(lines)]
    body = '\n'.join(body)

    # the one dynamic import: `await import('./x.js')` on a plain object is
    # fine, so it can resolve to the module's exports directly
    if mod.startswith('src/'):
        def fix(m):
            dep = resolve(m.group(1), mod)
            deps.append(dep)
            return f'__req({dep!r})'
        body = RE_DYNAMIC.sub(fix, body)

    tail = '\n'.join(f'  __x.{a} = {b};' for a, b in exports)
    return body, deps, tail


def collect():
    mods, order, state = {}, [], {}

    def visit(mod, stack):
        if state.get(mod) == 'done':
            return
        if state.get(mod) == 'open':
            cycle = ' -> '.join(stack[stack.index(mod):] + [mod])
            raise SystemExit(f'import cycle, which this bundler cannot fix:\n  {cycle}')
        state[mod] = 'open'
        body, deps, tail = transform(mod)
        mods[mod] = (body, tail)
        for d in deps:
            if not os.path.exists(os.path.join(ROOT, d)):
                raise SystemExit(f'{mod} imports {d}, which does not exist')
            visit(d, stack + [mod])
        state[mod] = 'done'
        order.append(mod)          # after its deps

    visit(ENTRY, [])
    return mods, order


def build():
    mods, order = collect()
    parts = ["""(() => {
'use strict';
const __defs = {};
const __cache = {};
function __req(id) {
  if (id in __cache) return __cache[id];
  const __x = {};
  __cache[id] = __x;           // before the body runs, so cycles see a stub
  __defs[id](__x, __req);
  return __x;
}"""]
    for mod in order:
        body, tail = mods[mod]
        parts.append(f"__defs[{mod!r}] = function (__x, __req) {{\n{body}\n{tail}\n}};")
    parts.append(f"__req({ENTRY!r}).boot();\n}})();")
    script = '\n'.join(parts)

    html = read('index.html')
    css = read('styles.css')

    html = html.replace('<link rel="stylesheet" href="styles.css">',
                        '<style>\n' + css + '\n</style>')
    html = re.sub(r'<script type="importmap">.*?</script>\n?', '', html, flags=re.S)
    # a function, not a string: the game's own source is full of things like
    # \w and \1 that re.sub would read as backreferences
    html, hits = re.subn(
        r"<script type=\"module\">\s*import \{ boot \}.*?</script>",
        lambda m: '<script type="module">\n' + script + '\n</script>',
        html, flags=re.S)
    if hits != 1:
        raise SystemExit(f'expected one entry script in index.html, found {hits}')

    # a note for whoever opens the file in an editor
    html = html.replace(
        '<title>',
        '<!-- Built by bundle.py from the SKYLINE source. Everything the game\n'
        '     needs is in this one file: no server, no install, no network.\n'
        '     Edit the source and re-run `python bundle.py`, not this. -->\n<title>')

    with open(os.path.join(ROOT, OUT), 'w', encoding='utf-8') as f:
        f.write(html)
    return len(order), len(html)


if __name__ == '__main__':
    n, size = build()
    print(f'{OUT}: {n} modules, {size / 1048576:.1f} MB')
    print('Double-click it. No server, no Python, no network.')
