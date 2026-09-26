#!/bin/sh
set -eu

version=${1:?usage: install-zig.sh <version>}
case "$version" in
  *[!0-9A-Za-z.+-]*) echo "invalid Zig version: $version" >&2; exit 1 ;;
esac

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=x86_64-linux ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-linux ;;
  *) echo "unsupported Zig host: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

if command -v zig >/dev/null 2>&1 && [ "$(zig version)" = "$version" ]; then
  exit 0
fi

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

curl --fail --silent --show-error --location \
  https://ziglang.org/download/index.json \
  --output "$temporary/index.json"
index_size=$(wc -c <"$temporary/index.json" | tr -d ' ')
if [ "$index_size" -gt 2097152 ]; then
  echo "Zig download index exceeds 2 MiB" >&2
  exit 1
fi

node --input-type=module - "$version" "$target" "$temporary/index.json" >"$temporary/metadata" <<'NODE'
import { readFile } from "node:fs/promises";

const [version, target, indexPath] = process.argv.slice(2);
const release = JSON.parse(await readFile(indexPath, "utf8"))[version];
const artifact = release?.[target];
if (!artifact?.tarball || !artifact?.shasum || !artifact?.size) {
  throw new Error(`Zig ${version} does not publish ${target}`);
}
const url = new URL(artifact.tarball);
if (url.protocol !== "https:" || !/^[0-9a-f]{64}$/.test(artifact.shasum)) {
  throw new Error(`Zig ${version} returned invalid ${target} metadata`);
}
process.stdout.write(`${url.href}\n${artifact.shasum}\n${artifact.size}\n`);
NODE

url=$(sed -n '1p' "$temporary/metadata")
sha256=$(sed -n '2p' "$temporary/metadata")
expected_size=$(sed -n '3p' "$temporary/metadata")
archive="$temporary/zig.tar.xz"
curl --fail --silent --show-error --location "$url" --output "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --strict -
actual_size=$(wc -c <"$archive" | tr -d ' ')
if [ "$actual_size" != "$expected_size" ]; then
  echo "Zig archive size mismatch: expected $expected_size, got $actual_size" >&2
  exit 1
fi

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

destination="/opt/zig-$version"
as_root rm -rf "$destination"
as_root mkdir -p "$destination"
as_root tar -xJf "$archive" --directory "$destination" --strip-components=1
as_root ln -sf "$destination/zig" /usr/local/bin/zig
test "$(zig version)" = "$version"
