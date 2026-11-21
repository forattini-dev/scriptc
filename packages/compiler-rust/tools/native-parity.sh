#!/usr/bin/env bash
# Usage: tools/native-parity.sh <fixture>...
# Builds each fixture with the native Rust driver (--no-engine) and compares the
# binary's stdout, stderr and exit code with the pinned Node oracle, byte for byte.
# Environment: NODE (oracle, default `node`; use the pinned 24.x), SCRIPTC (driver,
# default the debug build next to this script), OUT (scratch dir), CARGO_BUILD_JOBS.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
NODE=${NODE:-node}
SCRIPTC=${SCRIPTC:-$here/target/debug/scriptc${EXE_SUFFIX:-$( [ "${OS:-}" = Windows_NT ] && echo .exe )}}
OUT=${OUT:-${TMPDIR:-/tmp}/scriptc-parity}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-1}
mkdir -p "$OUT"
status=0
for f in "$@"; do
  name=$(echo "$f" | tr '/.:\' '____')
  dir=$(dirname "$f"); base=$(basename "$f")
  if ! "$SCRIPTC" build "$f" --no-engine --out "$OUT/$name.exe" > "$OUT/$name.build" 2>&1; then
    echo "BUILD-FAIL $f :: $(head -c 600 "$OUT/$name.build")"; status=1; continue
  fi
  (cd "$dir" && "$OUT/$name.exe" > "$OUT/$name.n.out" 2> "$OUT/$name.n.err"; echo $? > "$OUT/$name.n.code")
  (cd "$dir" && "$NODE" "$base" > "$OUT/$name.o.out" 2> "$OUT/$name.o.err"; echo $? > "$OUT/$name.o.code")
  if cmp -s "$OUT/$name.n.out" "$OUT/$name.o.out" && cmp -s "$OUT/$name.n.err" "$OUT/$name.o.err" && cmp -s "$OUT/$name.n.code" "$OUT/$name.o.code"; then
    echo "MATCH $f"
  else
    status=1
    echo "DIFF $f"; diff "$OUT/$name.n.out" "$OUT/$name.o.out" | head -20; diff "$OUT/$name.n.err" "$OUT/$name.o.err" | head -10
    echo "codes native=$(cat "$OUT/$name.n.code") node=$(cat "$OUT/$name.o.code")"
  fi
done
exit $status
