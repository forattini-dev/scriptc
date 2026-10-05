# Dogfood mission ledger

**Status: proposal.** This directory describes the Rust-lane dogfood mission as it has been probed so far, so that progress is measured by one repeatable instrument instead of ad hoc probes. The maintainer owns the definition of done; nothing here is an acceptance criterion.

## What the ledger measures

`pnpm dogfood:ledger` runs the compiler's analysis (`analyze()` from source, one child process per entry) over every entry of `mission.json` with the mission options (backend `rust`, `allowEngine: false`, `npmStatic: "auto"`, target `node26`, optimization `dev`) and prints one table row per entry. Each row says where a no-engine build stops today and how far it is:

- **stage**, in pipeline order: `unavailable` (the consumer or a required installed path is missing on this machine), `crashed` (the analysis threw), `preflight-failed` (TypeScript preflight failed, nothing lowered), `frontier` (lowering diagnostics above zero), `fenced` (zero lowering diagnostics, reached runtime fences above zero), `rejected` (lowering clean and fence-free, but IR validation or backend emission refused), `clean`.
- **blockers** = lowering diagnostics + reached runtime fences. This is what a no-engine build must clear: with `allowEngine: false` every reached runtime fence becomes a build-failing `SC3003` the moment the lowering diagnostics reach zero, so a "N diagnostics" headline is only the non-deferrable slice, never the distance. Post-lowering diagnostics (IR validation, backend refusals, an engine requirement) are a later wall and are reported separately.
- **fences** by code, by package (the last `node_modules` segment of the path, scoped names whole, `<program>` for first-party files), first-party versus third-party, by site (`startup` = recorded in module top-level initialisation, so the throw executes when the module evaluates; `function` = inside a function or closure body; `declaration` = during declaration registration), and the top root families after folding the generic-instantiation suffix and normalising quoted names. `SC2004` "inherit the blocker" cascades are counted apart from direct fences.
- **statements** total, failed and passing percentage; the **unreached** remainder's statements, failed statements, fences, diagnostics and skipped functions; the source count; the npm admission outcome (static count and the fallback packages with their reason); wall time and peak RSS.
- the consumer's identity: repository root, HEAD, dirty path count (porcelain lines, untracked files included; or, for the npm fixture, the lockfile hash and installed versions) and the distinct `@types/node` packages the checker program loaded, each with its version, root and file count. The record also names the compiler: this checkout's HEAD and how many tracked paths differed from it.
- for a preflight failure, the grouped TypeScript error families (pattern, count, files, name variants) instead of an empty row.

Without `--write` the table is followed by every headline metric that changed against the committed record. `--write` stores a compact record per entry under `tests/dogfood/ledger/<name>.json` (aggregate counts and top families only; paths are relativised to the root placeholders). `--entry <name>` (repeatable) narrows the run; `--json` prints the records instead of the table. An `unavailable` or `crashed` run never overwrites a committed record.

## Roots and overrides

Every path in `mission.json` is written with a placeholder resolved from an environment variable with a default: `${repo}` is this checkout, `${main}` the main checkout (the parent of the git common directory, so worktrees resolve it too; `SCRIPTC_DOGFOOD_MAIN`), `${workspace}` its parent (`SCRIPTC_DOGFOOD_WORKSPACE`), `${red-skills}` and `${red-dev}` the consumer repositories beside it (`SCRIPTC_DOGFOOD_RED_SKILLS`, `SCRIPTC_DOGFOOD_RED_DEV`), and `${baldim}` the installed Baldim probe workspace (`SCRIPTC_DOGFOOD_BALDIM`). A missing consumer makes its entries `unavailable`; it never fails the run.

## The Baldim fixture

`consumers/baldim-s3/` holds the two entries (`s3-client.ts`, `aws-config-probe.ts`), `package.json` and `package-lock.json` of the probe workspace that produced the probe history, without `node_modules`. Install it from scratch with `npm ci` inside that directory (the lockfile pins every version, `@types/node` 25.5.2 included); the ledger then finds it through the `${baldim}` default. To keep the numbers comparable with an existing probe workspace, point `SCRIPTC_DOGFOOD_BALDIM` at that installed directory instead. The entry's location influences the analysis (project configuration and type roots are discovered from it), so a baseline records which root it was taken from.

## Entries

The entries mirror the probes made so far: the Baldim S3 constructor smoke test and the AWS-SDK-only slice, the redskilled statusline and CLI entries, and the redwall renderer through the audit wrapper that targets a dirty red-dev working tree (another workstream is requalifying redwall against a clean clone; that entry will be replaced at integration). Adding an entry is adding an object to `entries`: `name`, `entry`, optional `requires` (paths that must exist for the entry to count as available), optional `consumer` (`{ "kind": "git", "root" }` or `{ "kind": "npm", "dir", "packages" }`), optional per-entry `options`, and a `note` that the record carries.
