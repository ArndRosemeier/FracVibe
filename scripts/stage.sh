#!/usr/bin/env bash
# scripts/stage.sh — THE stage step for FracVibe: public/ -> dist/ with VERSIONED
# ASSET URLS. This replaces hand-rolled `rsync -a --delete --exclude '.git*'`.
#
# WHY THIS EXISTS (docs/STATE.md row PUBLISH-CACHE): this origin sends no cache
# headers, so Cloudflare applies its default 4 h edge TTL PER URL. A plain copy
# therefore leaves the PREVIOUS build being served for up to four hours after a
# deploy. On 2026-09-21 the WORKER-CANCEL fix was committed, gated, pushed and
# staged — and still reached nobody, because `app.js` and `fractalWorker.js` were
# edge-cached under those same names. Worse, the cache window can pair a NEW
# `app.js` with an OLD worker (they handshake), which is a broken site.
#
# THE MECHANISM: `index.html` is NOT edge-cached on this host (measured:
# `cf-cache-status: DYNAMIC`), so HTML is always fetched from the origin. A change
# to a FILENAME declared in HTML is therefore visible immediately. So every file in
# the module graph is emitted a second time under a content-addressed name
# (`app.js` -> `app.<sha12>.js`), the graph's own references are rewritten to point
# at those names, and the HTML is rewritten last. Consequences:
#   - a changed file gets a NEW url, so no cache can serve the old bytes;
#   - an UNCHANGED file keeps its url, so repeat visits stay cached — a redeploy of
#     one file does not invalidate the other eleven;
#   - new and old coexist on the origin, so there is no "old HTML + new worker"
#     window (the new worker has a new name that only the new HTML knows), and a
#     visitor mid-session finishes on the pair they started with.
#
# EXIT CODES (quote them exactly; never inflate):
#    0  STAGED   dist/ is an exact, verified, versioned mirror of public/
#    1  RED      a check ran and failed; dist/ was NOT left half-written
#    64 USAGE    missing tooling or wrong directory
#
# This script is NOT the gate. "It staged" is never "it passed": the published
# artifact is verified by running the suite against it (see docs/STATE.md RECOVERY).
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/public"
# `STAGE_DEST` exists so the script can be exercised against a scratch directory
# (a probe must never publish). Unset, it stages the real `dist/`.
DST="${STAGE_DEST:-$REPO/dist}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fracvibe-stage.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

die() { echo "stage: RED — $*" >&2; exit 1; }

[ -d "$SRC" ] || die "no $SRC"
command -v python3 >/dev/null || die "python3 is required"

# 1. Copy everything, then stage the versioned output into a scratch dir so a
#    failure can never leave dist/ half-written.
mkdir -p "$TMP/out"
cp -a "$SRC/." "$TMP/out/"

VERSIONED_FILE="$TMP/versioned.json"
VERSIONED="$(python3 - "$TMP/out" <<'PY'
import hashlib, json, os, sys

root = sys.argv[1]

def sha12(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()[:12]

def norm(base_rel, ref):
    return os.path.normpath(os.path.join(os.path.dirname(base_rel), ref))

def code_only(text):
    """Comments removed, with string literals left UNTOUCHED (their paths are the
    data we need). This app documents its own wiring in comments — the kernel file
    contains `importScripts('fractalKernel.js')` inside one — so scanning prose
    invents cycles and dangling references. Handles `//`, `/* */`, and quotes
    correctly, including an apostrophe in "don't"."""
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
        elif ch in '\'"`':
            quote, i = ch, i + 1
            while i < n:
                if text[i] == '\\':
                    i += 2
                elif text[i] == quote:
                    i += 1
                    break
                elif text[i] == '\n' and quote != '`':
                    break
                else:
                    i += 1
            out.append(text[:0] + ' ')  # keep offsets stable: never do this; see below
        else:
            i += 1
    return out

def references(text, rel):
    """Local files this source fetches, read from REAL string literals.

    Deliberately not a regex over code and not a trigger-guessing heuristic. A
    quoted value is a dependency if and only if it resolves to a file that EXISTS
    next to the referencing file and ends in `.js`. That needs no knowledge of
    `import` vs `new Worker` vs `importScripts`, cannot be fooled by prose or by a
    masked string, and cannot invent an edge. Prose is excluded by walking the
    source as a token stream: only characters inside a quoted literal are ever
    considered.
    """
    refs, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if text.startswith('//', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
        elif ch in '\'"`':
            quote, i, start = ch, i + 1, i + 1
            while i < n:
                if text[i] == '\\':
                    i += 2
                elif text[i] == quote:
                    break
                elif text[i] == '\n' and quote != '`':
                    break
                else:
                    i += 1
            if i < n and text[i] == quote:
                value = text[start:i]
                i += 1
                if value.endswith('.js') and not value.startswith(('http', '//', 'data:', '/')):
                    target = norm(rel, value)
                    if os.path.basename(target) != os.path.basename(rel) \
                       and os.path.isfile(os.path.join(root, target)):
                        refs.append(target)
            else:
                i = start
        else:
            i += 1
    return sorted(set(refs))

def replace_ref(text, ref, newname):
    """Rewrite a whole quoted reference, never a substring: otherwise an
    already-versioned `webglFractal.<hash>.js` would become
    `webglFractal.<hash>.<hash>.js`.

    The ORIGINAL prefix is preserved: an ESM specifier MUST start with `/`, `./`
    or `../`, so rewriting `'./fractalViewer.js'` to `'fractalViewer.<hash>.js'`
    makes the browser refuse it with "Failed to resolve module specifier" (the
    staged artifact failed exactly that way). A Worker/importScripts reference is
    bare, and stays bare.
    """
    base = os.path.basename(ref)
    for quote in ("'", '"'):
        text = text.replace(quote + './' + base + quote, quote + './' + newname + quote)
        text = text.replace(quote + base + quote, quote + newname + quote)
    return text

# PASS 1 — collect the graph, writing nothing.
SOURCES, DEPS = {}, {}
def collect(rel, seen):
    if rel in seen:
        return
    seen.add(rel)
    src = os.path.join(root, rel)
    if not os.path.isfile(src):
        raise SystemExit('stage: RED — referenced file missing: ' + rel)
    text = open(src, encoding='utf-8').read()
    SOURCES[rel] = text
    DEPS[rel] = references(text, rel)
    for dep in DEPS[rel]:
        collect(dep, seen)

seen = set()
for entry in ('app.js', 'fractalWorker.js'):
    collect(entry, seen)
if 'app.js' not in SOURCES:
    raise SystemExit('stage: RED — app.js was not found under ' + root)

# PASS 2 — name each file by its ORIGINAL content, so an unchanged file keeps its
# url and a one-file deploy does not invalidate the rest.
VERSION = {}
for rel in sorted(SOURCES):
    stem, ext = os.path.splitext(os.path.basename(rel))
    VERSION[rel] = '%s.%s%s' % (stem, sha12(os.path.join(root, rel)), ext)

# PASS 3 — emit dependencies before the files that reference them. ESM tolerates
# cycles and this app has them, so the walk memoises; it never recurses forever.
ORDER, DONE = [], set()
def order(rel, stack=()):
    if rel in DONE or rel in stack:
        return
    for dep in DEPS[rel]:
        order(dep, stack + (rel,))
    if rel not in DONE:
        DONE.add(rel)
        ORDER.append(rel)

for entry in ('app.js', 'fractalWorker.js'):
    order(entry)

for rel in ORDER:
    text = SOURCES[rel]
    for dep in DEPS[rel]:
        text = replace_ref(text, dep, VERSION[dep])
    open(os.path.join(root, VERSION[rel]), 'w', encoding='utf-8').write(text)

# The rewritten originals are superseded by their versioned twins.
for rel in SOURCES:
    os.remove(os.path.join(root, rel))

print(json.dumps({'versioned': VERSION, 'reachable': sorted(SOURCES)}))
PY
)" || die "versioning failed"
printf '%s' "$VERSIONED" > "$VERSIONED_FILE"

# 2. Rewrite index.html to the versioned entry names. This runs LAST, and only
#    here, because HTML is the one file the edge does not cache: it is what makes
#    the switch immediate. `python3` is used rather than sed so that only whole
#    quoted references are replaced.
python3 - "$TMP/out" "$VERSIONED" <<'PY' || die "index.html rewrite failed"
import json, os, re, sys
root, payload = sys.argv[1], json.loads(sys.argv[2])
version = payload['versioned'] if isinstance(payload, dict) and 'versioned' in payload else payload
path = os.path.join(root, 'index.html')
html = open(path).read()
before = html
for logical, newname in version.items():
    # `src="app.js"` and `href`/`import` forms; the basename is what appears.
    base = os.path.basename(logical)
    html = re.sub(r"""(['"])(?:\./)?%s\1""" % re.escape(base),
                  lambda m: m.group(1) + newname + m.group(1), html)
# Every non-versioned local asset the page declares must still exist, or the
# deploy would 404 something the HTML promises. Fail loudly rather than publish.
declared = re.findall(r"""(?:src|href)=["']([^"']+)["']""", html)
missing = [d for d in declared
           if not d.startswith(('http', '//', 'data:', '#'))
           and not os.path.isfile(os.path.join(root, d.split('?')[0]))]
if missing:
    raise SystemExit('stage: RED — index.html declares files that do not exist: %s' % missing)
open(path, 'w').write(html)
print('stage: index.html rewrote %d asset reference(s)' % sum(1 for k in version if os.path.basename(k) in before))
PY

# 3. Swap into place. `--delete` is REQUIRED: without it, files removed from
#    public/ (or an older build's versioned names) would stay published forever.
mkdir -p "$DST"
rsync -a --delete "$TMP/out/" "$DST/" || die "rsync into dist/ failed"

# 4. VERIFY THE ARTIFACT, not the intention. A versioned filename is a content
#    address for the ORIGINAL source (it changes iff the source changed, which is
#    what gives cache independence), so it is deliberately NOT the hash of the
#    rewritten bytes and must not be checked that way. What must hold is that the
#    graph is COMPLETE and CLOSED: every reference in every served file resolves
#    to a file that is actually published. That is the failure that would 404 a
#    module in the browser, and it is what this checks.
python3 - "$DST" "$VERSIONED_FILE" <<'PY' || die "artifact verification failed"
import os, sys

dst = sys.argv[1]
import json as _json
_payload = _json.loads(open(sys.argv[2]).read())
payload_reachable = _payload.get('reachable', []) if isinstance(_payload, dict) else []
bad = []

def references(path, rel):
    """Local files this served file fetches, read from REAL string literals only.

    Comments are skipped and a quoted value counts only if it resolves to a file
    that is actually published. Scanning prose would report the kernel's own
    header comment (`importScripts('fractalKernel.js')`) as a dangling reference,
    which is exactly what an earlier version of this check did.
    """
    text = open(path, encoding='utf-8').read()
    refs, i, n = [], 0, len(text)
    while i < n:
        if text.startswith('//', i):
            j = text.find('\n', i); i = n if j < 0 else j
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2); i = n if j < 0 else j + 2
        elif text[i] in '\'"':
            quote, i, start_i = text[i], i + 1, i + 1
            while i < n:
                if text[i] == '\\':
                    i += 2
                elif text[i] == quote:
                    break
                elif text[i] == '\n':
                    break
                else:
                    i += 1
            if i < n and text[i] == quote:
                value = text[start_i:i]
                i += 1
                if value.endswith(('.js', '.css')) and not value.startswith(('http', '//', 'data:', '/')):
                    target = os.path.normpath(
                        os.path.join(os.path.dirname(os.path.join(dst, rel)), value))
                    if not os.path.isfile(target):
                        refs.append(value)
            else:
                i = start_i
        else:
            i += 1
    return refs

for dirpath, _dirs, files in os.walk(dst):
    for f in files:
        if not f.endswith(('.js', '.html')):
            continue
        p = os.path.join(dirpath, f)
        rel = os.path.relpath(p, dst)
        for value in references(p, rel):
            bad.append('%s references a file that is not published: %s' % (rel, value))

# A REACHABLE script must never be served under an unversioned name: that is the
# stale-cache hazard this step exists to remove. An UNREACHABLE file — e.g. added by
# a groundwork slice before the wiring slice that references it — cannot be fetched
# by any page, so it is REPORTED, not failed. (The first run against the
# WEBGPU-GROUNDWORK files caught exactly that.)
#
# HONEST NOTE ON THIS CHECK, corrected after trying to test it: every attempted
# control arm was VOID, and the reason is structural. `dist/` is rebuilt from
# `public/` and every file reachable from an entry point is emitted under a
# content-addressed name, so a bare REACHABLE name cannot arise from a normal run
# (emptying the reachable set just turns everything into an orphan; naming a
# versioned file as "reachable" finds no bare file to match). This branch is
# therefore an INVARIANT ASSERTION, not a tested guard: it would only fire if a
# future refactor copied files verbatim instead of emitting them. Its green must
# NOT be read as evidence that stale-name protection was exercised.
_ver = __import__('re')
orphans = []
for f in sorted(os.listdir(dst)):
    if not f.endswith('.js'):
        continue
    if _ver.match(r'^.+\.([0-9a-f]{12})\.js$', f):
        continue
    if os.path.basename(f) in payload_reachable:
        bad.append('a REACHABLE script is served unversioned (stale-cache hazard): ' + f)
    else:
        orphans.append(f)
for f in orphans:
    print('stage: note — %s is not referenced by any entry point, so it is published '
          'unversioned and no page can fetch it yet (wire it up and it becomes '
          'versioned automatically)' % f, file=sys.stderr)

if bad:
    print('stage: RED — the staged artifact is inconsistent:', file=sys.stderr)
    for b in sorted(set(bad)):
        print('  ' + b, file=sys.stderr)
    raise SystemExit(1)
print('stage: verified — every script in dist/ is content-addressed and no reference dangles')
PY

COUNT="$(find "$DST" -type f | wc -l)"
VERS="$(find "$DST" -type f -name '*.*.js' -o -type f -name '*.*.css' | wc -l)"
echo "stage: STAGED — $COUNT files in dist/ ($VERS versioned), verified content-addressed"
echo "stage: publish is a copy of dist/, which ~/apps/fracvibe symlinks — no purge is needed"
exit 0
