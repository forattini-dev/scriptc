// @rust-only
// @no-engine
import { Effect, Option } from 'effect';
import type { FileSystem, File, Size } from 'effect/FileSystem';
const instant = new Date('2026-01-02T03:04:05.006Z');
const info: File.Info = {
  type: 'File', mtime: Option.some(instant), atime: Option.none(), birthtime: Option.some(new Date(0)),
  dev: 1, ino: Option.some(2), mode: 420, nlink: Option.some(1), uid: Option.none(), gid: Option.none(),
  rdev: Option.none(), size: 9007199254740993n as Size, blksize: Option.some(4096n as Size), blocks: Option.some(8),
};
const stat: FileSystem['stat'] = (_path: string) => Effect.succeed(info);
const loaded = await Effect.runPromise(stat('file'));
console.log(loaded.type, loaded.dev, loaded.mode, String(loaded.size));
console.log(Option.getOrElse(loaded.mtime, () => new Date(0)).toISOString());
console.log(Option.getOrElse(loaded.mtime, () => new Date(0)) === instant);
console.log(Option.isNone(loaded.atime), Option.getOrElse(loaded.birthtime, () => instant).getTime());
console.log(Option.getOrElse(loaded.ino, () => -1), Option.getOrElse(loaded.nlink, () => -1));
console.log(Option.isNone(loaded.uid), Option.isNone(loaded.gid), Option.isNone(loaded.rdev));
console.log(String(Option.getOrElse(loaded.blksize, () => 0n as Size)), Option.getOrElse(loaded.blocks, () => 0));
function entryType(value: File.Info): string { return value.type; }
console.log(entryType(loaded));

function maybeStat(present: boolean): Effect.Effect<File.Info, string> {
  return present ? Effect.succeed(info) : Effect.fail('missing');
}
async function describe(present: boolean): Promise<string> {
  const value = await Effect.runPromise(maybeStat(present).pipe(Effect.catch(() => Effect.succeed(undefined))));
  if (value === undefined) return 'missing';
  return `${value.type}:${String(value.size)}:${Option.getOrElse(value.mtime, () => new Date(0)).getTime()}`;
}
console.log(await describe(true), await describe(false));
