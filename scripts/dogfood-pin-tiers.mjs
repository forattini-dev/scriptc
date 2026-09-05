#!/usr/bin/env node
// Turns a dogfood scoreboard's computed frontier into the target project's
// scriptc.json pins — the same file `--write-tiers` writes — so a build can
// reuse a long automatic fixpoint without repeating it.
//
// Usage: node scripts/dogfood-pin-tiers.mjs tests/dogfood/<name>.scoreboard.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const boardPath = process.argv[2];
if (!boardPath) { console.error("usage: dogfood-pin-tiers.mjs <scoreboard.json>"); process.exit(1); }
const board = JSON.parse(readFileSync(boardPath, "utf8"));
const frontier = board.frontier ?? [];
const island = frontier.filter((t) => t.tier === "island");
if (island.length === 0) { console.error("no island modules in the scoreboard's frontier"); process.exit(1); }
// The entry's package root: the nearest package.json above the entry.
let root = path.dirname(path.resolve(board.entry.startsWith("/") ? board.entry : path.join(process.cwd(), board.entry)));
while (!existsSync(path.join(root, "package.json")) && path.dirname(root) !== root) root = path.dirname(root);
const rows = island
  .map((t) => ({ module: path.relative(root, t.module).replace(/\\/g, "/"), reason: t.reason.replace(/^auto: /, "") }))
  .sort((a, b) => a.module.localeCompare(b.module));
const file = path.join(root, "scriptc.json");
let existing = {};
if (existsSync(file)) { try { existing = JSON.parse(readFileSync(file, "utf8")); } catch { existing = {}; } }
writeFileSync(file, `${JSON.stringify({ ...existing, tiers: { ...(existing.tiers ?? {}), island: rows } }, null, 2)}\n`);
console.log(`pinned ${rows.length} island modules into ${file}`);
