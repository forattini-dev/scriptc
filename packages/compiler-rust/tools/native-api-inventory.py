"""Cross-reference the pinned Node census and the current native manifest.

Usage: python packages/compiler-rust/tools/native-api-inventory.py --out report.json
The compiler executable is queried for metadata only; no application is run.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
COMPILER = ROOT / "packages/compiler-rust/target/debug" / ("scriptc.exe" if sys.platform == "win32" else "scriptc")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--compiler", type=Path, default=COMPILER)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    output = args.out.resolve()
    if output.exists():
        parser.error("output already exists; choose a new report path")
    manifest = json.loads(subprocess.run([str(args.compiler), "builtins"], check=True, capture_output=True, text=True, encoding="utf-8").stdout)
    census = read_json(ROOT / "internal/compatibility/generated/node-v24-internal.json")
    bun = read_json(ROOT / "internal/compatibility/runtime-reuse/bun.json")
    targets = read_json(ROOT / "packages/compiler-rust/targets/reddb-inventory.json")
    native = {f"{api['module']}.{api['member']}": api for api in manifest["apis"]}
    rows = []
    for row in census["rows"]:
        if row.get("scope") != "api":
            continue
        symbol = row.get("apiSymbol")
        if not symbol:
            continue
        entry = native.get(symbol)
        rows.append({
            "id": row["id"], "kind": row["kind"], "symbol": symbol,
            "signature": row["signature"], "chapter": row["chapter"],
            "nativeManifest": entry,
            "match": "exact" if entry else "unmatched-needs-review",
        })
    report = {
        "schemaVersion": 1,
        "scope": "Pinned Node documentation rows matched exactly against the Rust-native manifest; an unmatched row is not a support verdict. ECMAScript primitives and Bun APIs need independent authoritative inventories.",
        "engine": "none", "fallback": False,
        "nodeVersion": census["nodeVersion"], "nodeCommit": census["nodeCommit"],
        "nativeManifestScope": manifest["scope"],
        "summary": {"nodeApiRows": len(rows), "matches": dict(Counter(row["match"] for row in rows)), "nativeEntries": len(native), "nativeStringIntrinsics": len(manifest["stringIntrinsics"]), "bunReuseCandidates": len(bun["candidates"])},
        "nodeRows": rows,
        "nativeEntries": manifest["apis"],
        "nativeStringIntrinsics": manifest["stringIntrinsics"],
        "bunReuse": {"revision": bun["revision"], "scope": bun["scope"], "candidates": bun["candidates"]},
        "targetSnapshot": {"sourceState": targets.get("compilerSourceState"), "sourceTreeSha256": targets.get("compilerSourceTreeSha256"), "warning": targets.get("apiWarning"), "targets": [{"name": target["name"], "revision": target["revision"], "directNativeApiSignaturesMissing": target["directNativeApiSignaturesMissing"], "directGlobalCalls": target["directGlobalCalls"], "directGlobalValues": target["directGlobalValues"]} for target in targets["targets"]]},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write("\n")
    print(json.dumps(report["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
