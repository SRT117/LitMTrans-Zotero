#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

if command -v python3 >/dev/null 2>&1 && python3 -c "import sys" >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1 && python -c "import sys" >/dev/null 2>&1; then
  PYTHON=python
else
  echo "Python 3 is required to build LitMTrans." >&2
  exit 1
fi

./scripts/validate.sh
VERSION="$($PYTHON - <<'PY'
import json
print(json.load(open('manifest.json', encoding='utf-8'))['version'])
PY
)"
NAME="litmtrans-${VERSION}"
DIST="$ROOT/dist"
LITMTRANS_BUILD_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then
  LITMTRANS_BUILD_ROOT="$(cygpath -w "$ROOT")"
fi
export LITMTRANS_BUILD_ROOT
mkdir -p "$DIST"
# A running isolated Zotero test library reads its temporary extension from
# dist/addon.  Do not remove that directory when producing release archives:
# doing so turns every already-open workbench tab into a missing-file page.
rm -f "$DIST/${NAME}.xpi" "$DIST/${NAME}-source.zip"

cleanup_root_entries() {
  rm -f "$ROOT/bootstrap.js" "$ROOT/prefs.js"
}
trap cleanup_root_entries EXIT

RUNTIME=(
  manifest.json bootstrap.js prefs.js
  src assets locale
  README.md CHANGELOG.md PRIVACY.md SECURITY.md LICENSE THIRD_PARTY_NOTICES.md
)

echo "Building ${NAME}.xpi"
cp src/bootstrap.js bootstrap.js
cp src/prefs.js prefs.js
zip -X -q -r "$DIST/${NAME}.xpi" "${RUNTIME[@]}"
# 以 staged 前缀方式把 native/dist 的内容按 native/caj2pdf/* 路径追加进 XPI
STAGE="$DIST/.xpi-native-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/native"
cp -R native/dist/caj2pdf "$STAGE/native/"
(cd "$STAGE" && zip -X -q -r "$ROOT/dist/${NAME}.xpi" native)
rm -rf "$STAGE"
cleanup_root_entries

echo "Building ${NAME}-source.zip"
zip -X -q -r "$DIST/${NAME}-source.zip" . \
  -x 'dist/*' '.git/*' '.env' '.env.*' 'node_modules/*' '.npm-cache/*' '.zotero-dev/*' '.scaffold/*' '.validation-logs/*' \
     '.playwright-cli/*' 'output/*' 'tmp/*' 'coverage/*' '.idea/*' '.serena/*' 'native/caj-backend/target/*' 'feedbacks/*' 'scripts/manage_feedbacks.py' 'docs/feedback-management-guide.md' 'AGENTS.md' 'CLAUDE.md' 'zotero_ai_three_views_codex_execution_spec_v4.md' \
     '*.DS_Store' '__pycache__/*' '*.pyc' '*.xpi' '*.zip' '*.log'

$PYTHON - <<PY
from pathlib import Path
import hashlib, os, zipfile
root = Path(os.environ["LITMTRANS_BUILD_ROOT"])
dist = root / "dist"
xpi = dist / "${NAME}.xpi"
source = dist / "${NAME}-source.zip"
for archive, required in [
    (xpi, {"manifest.json", "bootstrap.js", "prefs.js", "src/ported-core.js", "src/controller.js", "src/caj-worker.js", "src/caj-converter.js", "assets/icon-48.png", "assets/icon-96.png", "assets/docs/token-guide.pdf", "assets/fonts/SourceHanSerifCN-Regular.ttf", "assets/fonts/LICENSE-SourceHanSerif.txt", "assets/vendor/mermaid/mermaid.min.js", "assets/vendor/mermaid/LICENSE", "native/caj2pdf/caj2pdf.wasm", "native/caj2pdf/LICENSE", "PRIVACY.md"}),
    (source, {"manifest.json", "package.json", "README.md", "LICENSE", "packages/core/src/translation.ts"}),
]:
    with zipfile.ZipFile(archive) as z:
        names = set(z.namelist())
        missing = required - names
        if missing:
            raise SystemExit(f"{archive.name} missing: {sorted(missing)}")
        forbidden = [n for n in names if (n.lower().endswith(".pdf") and n != "assets/docs/token-guide.pdf") or n.lower().endswith((".env", ".xpi")) or "/node_modules/" in f"/{n}" or n.startswith("node_modules/")]
        if forbidden:
            raise SystemExit(f"{archive.name} contains forbidden entries: {forbidden[:10]}")
for path in (xpi, source):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f"{path.name}  {path.stat().st_size} bytes  sha256:{digest}")
PY
