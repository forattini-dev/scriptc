import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directory, pin, sha256, snapshotDigest } from "./support.mjs";

const parent = join(directory, "../../node_modules/.cache/scriptc-test262");
const destination = join(parent, pin.commit);
mkdirSync(parent, { recursive: true });
if (existsSync(destination)) {
  if (snapshotDigest(destination) !== pin.snapshotSha256) throw new Error(`Modified snapshot: ${destination}`);
} else {
  const temporary = mkdtempSync(join(parent, "download-"));
  try {
    const response = await fetch(pin.archiveUrl);
    if (!response.ok) throw new Error(`Test262 download: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== pin.archiveSha256) throw new Error("Test262 archive checksum mismatch");
    const archive = join(temporary, "upstream.tar.gz");
    const extracted = join(temporary, "source");
    writeFileSync(archive, bytes);
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted, "--strip-components=1"]);
    if (snapshotDigest(extracted) !== pin.snapshotSha256) throw new Error("Test262 content checksum mismatch");
    renameSync(extracted, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
console.log(destination);
