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
LITMTRANS_SOURCE_ARCHIVE="${NAME}-source.zip"
export LITMTRANS_SOURCE_ARCHIVE
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
  docs/licensing
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
$PYTHON - <<'PY'
from pathlib import Path
import os
import re
import subprocess
import zipfile

root = Path(os.environ["LITMTRANS_BUILD_ROOT"])
source = root / "dist" / os.environ["LITMTRANS_SOURCE_ARCHIVE"]
raw_paths = subprocess.run(
    ["git", "ls-files", "-z"], cwd=root, check=True, stdout=subprocess.PIPE
).stdout.split(b"\0")
tracked = [os.fsdecode(item).replace("\\", "/") for item in raw_paths if item]

def forbidden_reason(name):
    parts = name.split("/")
    lower = name.lower()
    basename = Path(name).name
    if basename == ".env" or basename.startswith(".env."):
        return "environment file"
    if name in {".mutagen.yml", ".mutagen.yml.lock", ".vscode/settings.json", ".vscode/tasks.json", "docs/feedback-management-guide.md", "docs/repo-map.md"}:
        return "local configuration or generated documentation"
    if parts[0] == "dist":
        return "generated release output"
    if any(part in {".serena", ".zotero-dev", "node_modules", ".npm-cache", ".scaffold", ".validation-logs", ".playwright-cli", "coverage", "output", "tmp", "__pycache__", "target", "cookies", "sessions", "session-storage", "runtime"} for part in parts):
        return "local runtime, profile, or cache"
    if lower.endswith((".xpi", ".pyc", ".log")) or Path(name).name in {"id_rsa", "id_ed25519"}:
        return "generated or credential artifact"
    if lower.endswith(".pdf") and name != "assets/docs/token-guide.pdf":
        return "temporary or local PDF"
    if re.search(r"\.(?:p12|pfx|pem|key)$", lower):
        return "private credential file"
    return None

excluded = [name for name in tracked if forbidden_reason(name)]
tracked = [name for name in tracked if not forbidden_reason(name)]
if excluded:
    print(f"Excluded {len(excluded)} forbidden/local tracked paths")

with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in sorted(tracked):
        file_path = root / Path(name)
        if not file_path.is_file() and not file_path.is_symlink():
            raise SystemExit(f"Tracked source file is missing: {name}")
        archive.writestr(name, file_path.read_bytes())
print(f"Source archive files: {len(tracked)} (Git tracked paths only)")
PY

$PYTHON - <<PY
from pathlib import Path
import hashlib, os, zipfile
import subprocess
root = Path(os.environ["LITMTRANS_BUILD_ROOT"])
dist = root / "dist"
xpi = dist / "${NAME}.xpi"
source = dist / "${NAME}-source.zip"
for archive, required in [
    (xpi, {"manifest.json", "bootstrap.js", "prefs.js", "src/ported-core.js", "src/controller.js", "src/caj-worker.js", "src/caj-converter.js", "assets/icon-48.png", "assets/icon-96.png", "assets/docs/token-guide.pdf", "assets/fonts/SourceHanSerifCN-Regular.ttf", "assets/fonts/LICENSE-SourceHanSerif.txt", "assets/vendor/katex/LICENSE.txt", "assets/vendor/licenses/KaTeX-Fonts-OFL-1.1.txt", "assets/vendor/mermaid/mermaid.min.js", "assets/vendor/mermaid/LICENSE", "assets/vendor/licenses/npm/pako@2.1.0/LICENSE", "assets/vendor/licenses/npm/pako@2.1.0/LICENSE-ZLIB.txt", "assets/vendor/licenses/zotero-mcp-MIT.txt", "native/caj2pdf/caj2pdf.wasm", "native/caj2pdf/LICENSE", "native/caj2pdf/UPSTREAM.md", "docs/licensing/third-party-inventory.md", "docs/licensing/acquisition-runtime.md", "docs/licensing/caj-backend.md", "PRIVACY.md", "THIRD_PARTY_NOTICES.md"} | {"assets/vendor/licenses/" + p.relative_to(root / "assets/vendor/licenses").as_posix() for p in (root / "assets/vendor/licenses").rglob("*") if p.is_file()}),
    (source, {"manifest.json", "package.json", "README.md", "LICENSE", "packages/core/src/translation.ts", "native/caj-backend/LICENSE", "native/caj-backend/UPSTREAM.md", "native/caj-backend/Cargo.toml", "native/caj-backend/Cargo.lock", "native/caj-backend/crates/jbig1/src/codec.rs"}),
]:
    with zipfile.ZipFile(archive) as z:
        names = set(z.namelist())
        missing = required - names
        if missing:
            raise SystemExit(f"{archive.name} missing: {sorted(missing)}")
        forbidden = [
            n for n in names
            if Path(n).name == ".env" or Path(n).name.startswith(".env.")
            or n in {".mutagen.yml", ".mutagen.yml.lock", ".vscode/settings.json", ".vscode/tasks.json", "docs/feedback-management-guide.md", "docs/repo-map.md"}
            or n.split("/")[0] == "dist"
            or any(part in {".serena", ".zotero-dev", "node_modules", ".npm-cache", ".scaffold", ".validation-logs", ".playwright-cli", "coverage", "output", "tmp", "__pycache__", "target", "cookies", "sessions", "session-storage", "runtime"} for part in n.split("/"))
            or n.lower().endswith((".pdf", ".xpi", ".pyc", ".log", ".p12", ".pfx", ".pem", ".key")) and n != "assets/docs/token-guide.pdf"
            or Path(n).name in {"id_rsa", "id_ed25519"}
        ]
        if forbidden:
            raise SystemExit(f"{archive.name} contains forbidden entries: {forbidden[:10]}")
        if archive == source:
            tracked_raw = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, stdout=subprocess.PIPE).stdout
            tracked_names = {os.fsdecode(item) for item in tracked_raw.split(b"\0") if item}
            if not names.issubset(tracked_names):
                raise SystemExit(f"{archive.name} contains untracked paths: {sorted(names - tracked_names)[:10]}")
            if "native/caj-backend/target" in names or any(n.startswith("native/caj-backend/target/") for n in names):
                raise SystemExit(f"{archive.name} contains CAJ build output")
            print(f"Source archive tracked-only check passed: {len(names)} files; forbidden tracked paths excluded; CAJ Rust source included")
for path in (xpi, source):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f"{path.name}  {path.stat().st_size} bytes  sha256:{digest}")
PY
