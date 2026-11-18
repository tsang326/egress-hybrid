#!/bin/bash
# Regenerate validation/reference/ by running a local CFAST 7.7.7 binary on every case.
# Usage: CFAST=/path/to/cfast7_osx tools/cfast/run-references.sh
# Build CFAST from https://github.com/firemodels/cfast (tag CFAST-7.7.7): Build/CFAST/gnu_osx/make_cfast.sh
#
# Checks (Requirement 12.2): $CFAST is set, exists, is executable and reports CFAST-7.7.7.
# Nothing in validation/reference/ is touched before these pass.
# Each case gets a time limit (Requirement 12.8): 600 s, or CFAST_CASE_TIMEOUT_S (used by tests only).
# Failures print "FAILED: <case>: <reason>", the run continues, and the exit code is non-zero at the end.
# Outputs are built in a temporary directory and copied only when both CSV files exist.
#
# Optional overrides, for tests: CFAST_CASE_TIMEOUT_S, CFAST_CASES_DIR, CFAST_REFERENCE_DIR.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cases_dir="${CFAST_CASES_DIR:-$root/validation/cases}"
ref_dir="${CFAST_REFERENCE_DIR:-$root/validation/reference}"
case_timeout_s="${CFAST_CASE_TIMEOUT_S:-600}"   # Requirement 12.8
version_timeout_s=60
version_re='^Revision[[:space:]]*:[[:space:]]*CFAST-7\.7\.7-'

if [ -z "${CFAST:-}" ]; then
  echo "ERROR: set CFAST to the cfast binary" >&2; exit 2
fi
if [ ! -e "$CFAST" ]; then
  echo "ERROR: CFAST binary not found: $CFAST" >&2; exit 2
fi
if [ ! -f "$CFAST" ] || [ ! -x "$CFAST" ]; then
  echo "ERROR: CFAST is not an executable file: $CFAST" >&2; exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# run_limited SECONDS OUTFILE ARGS...  -> runs "$CFAST" ARGS in the current directory, stdout+stderr to OUTFILE.
# Returns the exit code; 124 means the time limit was hit.
run_limited() {
  local secs="$1" outfile="$2" rc=0
  shift 2
  local tmo=""
  if command -v timeout > /dev/null 2>&1; then tmo=timeout
  elif command -v gtimeout > /dev/null 2>&1; then tmo=gtimeout; fi
  if [ -n "$tmo" ]; then
    "$tmo" -k 5 "$secs" "$CFAST" "$@" < /dev/null > "$outfile" 2>&1 || rc=$?
    return "$rc"
  fi
  # Background watchdog for systems without timeout (stock macOS).
  local flag="$outfile.timedout" pid wd
  rm -f "$flag"
  "$CFAST" "$@" < /dev/null > "$outfile" 2>&1 &
  pid=$!
  ( sleep "$secs"; : > "$flag"; kill -TERM "$pid" 2> /dev/null; sleep 5; kill -KILL "$pid" 2> /dev/null ) > /dev/null 2>&1 &
  wd=$!
  wait "$pid" || rc=$?
  kill "$wd" 2> /dev/null || true
  wait "$wd" 2> /dev/null || true
  if [ -e "$flag" ]; then rc=124; fi
  return "$rc"
}

# Version check: run with no arguments, ignore the exit code, require the Revision line.
mkdir "$work/version"
vrc=0
(cd "$work/version" && run_limited "$version_timeout_s" "$work/version.out") || vrc=$?
if [ "$vrc" -eq 124 ]; then
  echo "ERROR: CFAST did not finish its version output within ${version_timeout_s} s" >&2; exit 3
fi
if ! grep -Eq "$version_re" "$work/version.out"; then
  found="$(grep -E '^Revision' "$work/version.out" | head -n 1 || true)"
  echo "ERROR: CFAST 7.7.7 required. Revision line found: ${found:-<none>}" >&2; exit 3
fi
echo "Using $(grep -E "$version_re" "$work/version.out" | head -n 1)"

failures=0
total=0
list="$(find "$cases_dir" -name '*.in' | LC_ALL=C sort)"   # list is built before the loop; no pipeline around the loop
while IFS= read -r f; do
  [ -n "$f" ] || continue
  total=$((total + 1))
  rel="${f#"$cases_dir/"}"; rel="${rel%.in}"; name="$(basename "$f" .in)"
  cdir="$work/case_$total"
  mkdir "$cdir"; cp "$f" "$cdir/"
  rc=0
  (cd "$cdir" && run_limited "$case_timeout_s" "$cdir/cfast.log" "$name.in" -V) || rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "FAILED: $rel: timed out after ${case_timeout_s} s"; failures=$((failures + 1)); continue
  elif [ "$rc" -ne 0 ]; then
    echo "FAILED: $rel: CFAST exited with code $rc"; failures=$((failures + 1)); continue
  fi
  comp="$cdir/${name}_compartments.csv"; vents="$cdir/${name}_vents.csv"
  if [ ! -f "$comp" ] || [ ! -f "$vents" ]; then
    echo "FAILED: $rel: missing output CSV (${name}_compartments.csv and ${name}_vents.csv are both required)"
    failures=$((failures + 1)); continue
  fi
  out="$ref_dir/$(dirname "$rel")"
  mkdir -p "$out"
  cp "$comp" "$vents" "$out/"
done <<EOF
$list
EOF

echo "Cases run: $total, failed: $failures"
if [ "$failures" -ne 0 ]; then exit 1; fi
