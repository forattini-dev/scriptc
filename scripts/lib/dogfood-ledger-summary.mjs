// The dogfood ledger's pure summariser: turns one entry's analysis result
// (the compiler's CoverageInput plus the driver's measurements) into the
// compact per-consumer distance record that tests/dogfood/ledger/<name>.json
// stores, and renders records as the one-screen table with deltas. No file
// system, no process, no compiler import — scripts/dogfood-ledger.mjs owns
// those, so everything here is unit-testable from fixtures.
//
// The distance a no-engine build must clear is `blockers`: the lowering
// diagnostics PLUS every reached runtime fence, because with allowEngine
// false each deferred fence becomes a build-failing SC3003 the moment the
// lowering diagnostics reach zero. A "N diagnostics" headline alone is the
// non-deferrable slice, never the distance.

/** Schema 2: the post-lowering wall is null (unmeasured) while the module
 * did not lower, import-form fences count as blockers, and first-party
 * attribution can name consumer packages. */
export const LEDGER_SCHEMA = 2;

/** Where a no-engine build of the entry stops today, in pipeline order.
 * - unavailable: the consumer (entry, or a required installed path) is missing on this machine.
 * - crashed: analyze() threw (an uncaught compiler exception, not a diagnostic).
 * - preflight-failed: tsc preflight failed; nothing lowered.
 * - frontier: lowering diagnostics above zero (the module did not lower, or a preflight import-form fence stands; its blockers are a floor).
 * - fenced: the module lowered with zero diagnostics, but reached runtime fences remain (each is an SC3003 without an engine).
 * - rejected: zero diagnostics and zero fences from lowering, but IR validation or backend emission refused the module.
 * - clean: nothing blocks a no-engine build. */
export const STAGES = ["unavailable", "crashed", "preflight-failed", "frontier", "fenced", "rejected", "clean"];

const FENCE_MIRROR_PREFIX = "--no-engine refuses deferred unsupported functionality: [";
const CASCADE_RE = /^uses of '.*' inherit the blocker on its declaration/;
const INSTANTIATION_MARK = " (instantiating '";
const PROGRAM = "<program>";

/** Import-FORM fences (unsupported import/require/export shapes). Only the
 * frontend's preflight raises them; analyze() lets them through, prepends
 * them to the diagnostics and keeps analysing, while a build refuses them
 * before lowering. They are blockers whether or not the module lowered. */
const IMPORT_FENCE_CODES = new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015"]);

/** True for a preflight import-form fence row. */
export function isImportFence(diagnostic) {
  return IMPORT_FENCE_CODES.has(diagnostic.code);
}

/** A package-name matcher for "first party": the program's own files
 * (`<program>`, outside node_modules) plus the consumer's declared
 * packages, each an exact name or a glob where `*` matches any run of
 * characters ("@baldim/*"). */
export function firstPartyMatcher(patterns = []) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = patterns.map((pattern) => new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`));
  return (pkg) => pkg === PROGRAM || regexes.some((re) => re.test(pkg));
}

/** The npm package a file belongs to: the LAST node_modules segment of the
 * path (pnpm's virtual store nests `node_modules/.pnpm/<id>/node_modules/
 * <name>`), scoped names kept whole; "<program>" for first-party files. */
export function packageOfPath(file) {
  const normalized = String(file).replace(/\\/g, "/");
  const marker = "/node_modules/";
  let index = normalized.lastIndexOf(marker);
  while (index !== -1) {
    const rest = normalized.slice(index + marker.length);
    const parts = rest.split("/");
    const name = parts[0]?.startsWith("@") && parts[1] !== undefined ? `${parts[0]}/${parts[1]}` : parts[0];
    if (name && name !== ".pnpm" && !name.startsWith(".")) return name;
    index = normalized.lastIndexOf(marker, index - 1);
  }
  return PROGRAM;
}

/** True for the SC3003 rows analyze() derives 1:1 from the reached runtime
 * fences under allowEngine false — the same sites counted as fences, so
 * they never count twice. */
export function isFenceMirror(diagnostic) {
  return diagnostic.code === "SC3003" && diagnostic.message.startsWith(FENCE_MIRROR_PREFIX);
}

/** True for the SC2004 "inherit the blocker" cascade marker a use site of a
 * blocked declaration carries — counted apart from direct fences. */
export function isCascade(diagnostic) {
  return diagnostic.code === "SC2004" && CASCADE_RE.test(diagnostic.message);
}

/** Drops the generic-instance suffix lowering appends to every diagnostic
 * raised inside an instantiated body: " (instantiating 'f' with (...))". */
export function foldInstantiation(message) {
  const at = message.indexOf(INSTANTIATION_MARK);
  if (at === -1 || !message.endsWith(")")) return { message, instantiated: false };
  return { message: message.slice(0, at), instantiated: true };
}

const OPENER_PREV = new Set([" ", "(", "[", "{", "<", "|", ",", ":", "="]);
const CLOSER_NEXT = new Set([" ", ")", "]", "}", ">", "|", ",", ".", ";", ":", "?", "-", "!", "\n"]);

/** Scans a message for its quoted names. Compiler messages nest quotes
 * ("'new RegExp with a 'RegExp' pattern' is part of ...") and type texts
 * carry inner quotes, so a quote opens a name only after a delimiter and
 * closes one only before a delimiter; an apostrophe inside a word is text.
 * Unbalanced input falls back to the lazy regex reading. Returns the
 * message with each top-level quoted name replaced by '_' plus the names. */
function scanQuotes(message) {
  let out = "";
  const names = [];
  let depth = 0;
  let nameStart = 0;
  for (let i = 0; i < message.length; i++) {
    const ch = message[i];
    if (ch !== "'") {
      if (depth === 0) out += ch;
      continue;
    }
    const prev = i === 0 ? " " : message[i - 1];
    const next = i + 1 < message.length ? message[i + 1] : " ";
    const opener = OPENER_PREV.has(prev) && !CLOSER_NEXT.has(next) && next !== "'";
    const closer = CLOSER_NEXT.has(next) || next === "'";
    if (depth === 0) {
      if (opener) {
        depth = 1;
        nameStart = i + 1;
      } else {
        out += ch;
      }
      continue;
    }
    if (opener && !closer) {
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        names.push(message.slice(nameStart, i));
        out += "'_'";
      }
    }
  }
  if (depth !== 0) {
    const fallbackNames = [];
    const folded = message.replace(/'([^']*)'/g, (_, name) => {
      fallbackNames.push(name);
      return "'_'";
    });
    return { folded, names: fallbackNames };
  }
  return { folded: out, names };
}

/** The message with every quoted name replaced by '_'. */
export function foldQuotedNames(message) {
  return scanQuotes(message).folded;
}

/** The quoted names of a message, in order. */
export function quotedNames(message) {
  return scanQuotes(message).names;
}

/** The root family of a lowering diagnostic or runtime fence: instantiation
 * suffix folded, quoted names normalised, the "is/are not supported yet"
 * tail dropped (the coverage report drops it too). */
export function familyOf(diagnostic) {
  const { message, instantiated } = foldInstantiation(diagnostic.message);
  const family = foldQuotedNames(message).replace(/ (?:is|are) not supported yet$/, "");
  return { code: diagnostic.code, family, instantiated };
}

function sortedCounts(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function emptySites() {
  return { moduleInit: 0, function: 0, declaration: 0 };
}

const SITE_KEY = { "module-init": "moduleInit", function: "function", declaration: "declaration" };

/** A site the summariser does not know (a newer compiler) is counted under
 * its own key rather than folded into a known one. */
function siteKeyOf(site) {
  return SITE_KEY[site] ?? "unknown";
}

function bumpSite(sites, site) {
  sites[site] = (sites[site] ?? 0) + 1;
}

/** Folds diagnostics into code / package / family tallies. `sites` is the
 * parallel RuntimeFenceSite array when the rows are runtime fences. */
export function foldDiagnostics(diagnostics, { sites = null, topFamilies = 25, relativize = (s) => s, isFirstParty = (pkg) => pkg === PROGRAM } = {}) {
  const byCode = new Map();
  const byPackage = new Map();
  const families = new Map();
  const bySite = emptySites();
  const cascadeBindings = new Set();
  let cascades = 0;
  const cascadeSites = emptySites();
  let firstParty = 0;
  let instantiated = 0;
  diagnostics.forEach((diagnostic, index) => {
    const site = sites === null ? null : siteKeyOf(sites[index]);
    const pkg = packageOfPath(diagnostic.loc?.file ?? "");
    bump(byCode, diagnostic.code);
    bump(byPackage, pkg);
    if (isFirstParty(pkg)) firstParty++;
    if (site !== null) bumpSite(bySite, site);
    if (isCascade(diagnostic)) {
      cascades++;
      if (site !== null) bumpSite(cascadeSites, site);
      const name = quotedNames(diagnostic.message)[0] ?? "";
      cascadeBindings.add(`${diagnostic.loc?.file ?? ""}\u0000${name}`);
      return;
    }
    const fam = familyOf(diagnostic);
    if (fam.instantiated) instantiated++;
    const key = `${fam.code}\u0000${fam.family}`;
    let row = families.get(key);
    if (!row) {
      row = { code: fam.code, family: relativize(fam.family), count: 0, packages: new Map(), sites: sites === null ? null : emptySites() };
      families.set(key, row);
    }
    row.count++;
    bump(row.packages, pkg);
    if (site !== null) bumpSite(row.sites, site);
  });
  const rows = [...families.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.family.localeCompare(b.family));
  return {
    total: diagnostics.length,
    direct: diagnostics.length - cascades,
    cascades: { total: cascades, distinctBindings: cascadeBindings.size, ...(sites === null ? {} : { bySite: cascadeSites }) },
    instantiated,
    byCode: sortedCounts(byCode),
    byPackage: sortedCounts(byPackage),
    firstParty,
    thirdParty: diagnostics.length - firstParty,
    ...(sites === null ? {} : { bySite }),
    familyCount: rows.length,
    families: rows.slice(0, topFamilies).map((row) => ({
      code: row.code,
      family: row.family,
      count: row.count,
      ...(row.sites === null ? {} : { sites: row.sites }),
      packages: Object.fromEntries([...row.packages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)),
    })),
  };
}

/** Groups TypeScript preflight errors (SC0001 pass-through rows) into
 * message families: the pattern with quoted names normalised, plus the
 * distinct name tuples that instantiate it. */
export function foldPreflight(diagnostics, { topFamilies = 25, topVariants = 8, relativize = (s) => s, isFirstParty = (pkg) => pkg === PROGRAM } = {}) {
  const byCode = new Map();
  const byPackage = new Map();
  const families = new Map();
  let firstParty = 0;
  for (const diagnostic of diagnostics) {
    const pkg = packageOfPath(diagnostic.loc?.file ?? "");
    bump(byCode, diagnostic.code);
    bump(byPackage, pkg);
    if (isFirstParty(pkg)) firstParty++;
    const { folded, names } = scanQuotes(diagnostic.message);
    const key = `${diagnostic.code}\u0000${folded}`;
    let row = families.get(key);
    if (!row) {
      row = { code: diagnostic.code, pattern: relativize(folded), count: 0, variants: new Map(), files: new Set() };
      families.set(key, row);
    }
    row.count++;
    bump(row.variants, relativize(names.join(" · ")));
    row.files.add(diagnostic.loc?.file ?? "");
  }
  const rows = [...families.values()].sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
  return {
    total: diagnostics.length,
    byCode: sortedCounts(byCode),
    byPackage: sortedCounts(byPackage),
    firstParty,
    thirdParty: diagnostics.length - firstParty,
    familyCount: rows.length,
    families: rows.slice(0, topFamilies).map((row) => ({
      code: row.code,
      pattern: row.pattern,
      count: row.count,
      files: row.files.size,
      variants: Object.fromEntries([...row.variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topVariants)),
    })),
  };
}

function pct(numerator, denominator) {
  return denominator === 0 ? 100 : Math.round((numerator / denominator) * 1000) / 10;
}

/** Summarises one analyzed entry. `analysis` is null when the consumer is
 * unavailable or the analysis crashed (then `unavailable` / `crashed`
 * carry the reason). The record never holds per-fence rows or absolute
 * machine paths: `relativize` maps every path-bearing string onto the
 * mission's root placeholders before it lands in the record.
 * `firstPartyPackages` names the consumer's own packages (exact names or
 * `*` globs) that live in node_modules; files outside node_modules are
 * always first party. */
export function summarizeEntry({
  name,
  entry,
  options,
  consumer = null,
  compiler = null,
  analysis = null,
  unavailable = null,
  crashed = null,
  generatedAt = null,
  node = null,
  relativize = (s) => s,
  topFamilies = 25,
  firstPartyPackages = [],
}) {
  const isFirstParty = firstPartyMatcher(firstPartyPackages);
  const base = {
    schema: LEDGER_SCHEMA,
    name,
    ...(generatedAt === null ? {} : { generatedAt }),
    ...(node === null ? {} : { node }),
    ...(compiler === null ? {} : { compiler }),
    entry: relativize(entry),
    options,
    ...(consumer === null ? {} : { consumer }),
    ...(firstPartyPackages.length === 0 ? {} : { firstPartyPackages }),
  };
  if (unavailable !== null) {
    return { ...base, stage: "unavailable", unavailable: relativize(unavailable) };
  }
  if (crashed !== null) {
    return {
      ...base,
      stage: "crashed",
      crashed: { name: crashed.name ?? "Error", message: relativize(String(crashed.message ?? crashed)), ...(crashed.stackHead ? { stackHead: relativize(crashed.stackHead) } : {}) },
      ...(analysis?.elapsedMs === undefined ? {} : { elapsedMs: analysis.elapsedMs }),
    };
  }
  const { coverage } = analysis;
  const measured = {
    elapsedMs: analysis.elapsedMs ?? null,
    ...(analysis.peakRssKiB === undefined ? {} : { peakRssKiB: analysis.peakRssKiB }),
    sources: analysis.sources ?? null,
    npmStatic: summarizeNpmStatic(coverage.npmStatic ?? [], relativize),
  };
  if (coverage.preflightFailed) {
    const preflight = foldPreflight(coverage.diagnostics, { topFamilies, relativize, isFirstParty });
    return {
      ...base,
      stage: "preflight-failed",
      blockers: { total: null, note: "preflight failed: nothing lowered, so the lowering distance is unmeasured" },
      preflight,
      ...measured,
    };
  }
  const mirrors = coverage.diagnostics.filter(isFenceMirror);
  const real = coverage.diagnostics.filter((d) => !isFenceMirror(d));
  // analyze() appends IR validation, backend and engine-requirement rows
  // only once the module lowered (then `execution` is set and lowering left
  // no diagnostics of its own). While the module did not lower, every row is
  // a blocker and the post-lowering wall is UNMEASURED (null), not zero.
  // Preflight import-form fences are blockers either way: analyze() prepends
  // them, they do not stop the lowering, and a build refuses them first.
  const lowered = coverage.execution !== undefined;
  const importFences = real.filter(isImportFence);
  const loweringDiagnostics = lowered ? importFences : real;
  const postLowering = lowered ? real.filter((d) => !isImportFence(d)) : null;
  const fences = coverage.runtimeFences ?? [];
  // analyze() omits both arrays when nothing fenced; an empty site list
  // keeps the site breakdown present (all zero) for such a record.
  const fenceSites = coverage.runtimeFenceSites ?? (fences.length === 0 ? [] : null);
  const engineRequired = lowered ? coverage.execution.engine !== "none" : null;
  const stage =
    loweringDiagnostics.length > 0 ? "frontier"
      : fences.length > 0 ? "fenced"
        : postLowering !== null && postLowering.length > 0 ? "rejected"
          : "clean";
  const un = coverage.unreached ?? null;
  const unreachedFences = un?.runtimeFences ?? [];
  const unreachedSites = un?.runtimeFenceSites ?? (unreachedFences.length === 0 ? [] : null);
  const stats = coverage.stats;
  return {
    ...base,
    stage,
    blockers: {
      total: loweringDiagnostics.length + fences.length,
      loweringDiagnostics: loweringDiagnostics.length,
      importFences: importFences.length,
      reachedFences: fences.length,
      fenceMirrors: mirrors.length,
      postLoweringDiagnostics: postLowering === null ? null : postLowering.length,
      atLeast: stage === "frontier",
      note: "what a no-engine build must clear: the lowering diagnostics plus every reached runtime fence (each becomes an SC3003 once lowering is clean). At a frontier the total is a floor: code behind a failing statement is not measured, and IR validation and backend checks (the post-lowering wall, null here) run only once the module lowers.",
    },
    diagnostics: {
      lowering: foldDiagnostics(loweringDiagnostics, { topFamilies, relativize, isFirstParty }),
      postLowering: postLowering === null ? null : foldDiagnostics(postLowering, { topFamilies, relativize, isFirstParty }),
      engineRequired,
    },
    fences: foldDiagnostics(fences, { sites: fenceSites, topFamilies, relativize, isFirstParty }),
    statements: {
      total: stats.statementsTotal,
      failed: stats.statementsFailed,
      island: stats.statementsIsland,
      passingPct: pct(stats.statementsTotal - stats.statementsFailed - stats.statementsIsland, stats.statementsTotal),
      functionsSkipped: stats.functionsSkipped,
    },
    unreached: un === null ? null : {
      statements: un.stats.statementsTotal,
      failed: un.stats.statementsFailed,
      island: un.stats.statementsIsland,
      functionsSkipped: un.stats.functionsSkipped,
      diagnostics: foldDiagnostics(un.diagnostics, { topFamilies: Math.min(topFamilies, 10), relativize, isFirstParty }),
      fences: foldDiagnostics(unreachedFences, { sites: unreachedSites, topFamilies: Math.min(topFamilies, 10), relativize, isFirstParty }),
    },
    ...measured,
  };
}

function summarizeNpmStatic(rows, relativize) {
  const fallback = rows.filter((r) => r.status === "fallback").map((r) => ({ package: r.package, reason: relativize(r.detail ?? "") }));
  return { static: rows.filter((r) => r.status === "static").length, fallbackCount: fallback.length, fallback };
}

/** The headline metrics a delta compares, flat and numeric (stage as text). */
export function headline(record) {
  if (!record) return {};
  const h = { stage: record.stage };
  if (record.stage === "unavailable" || record.stage === "crashed") return h;
  h.elapsedMs = record.elapsedMs ?? null;
  h.sources = record.sources ?? null;
  if (record.npmStatic) {
    h.npmStatic = record.npmStatic.static;
    h.npmFallback = record.npmStatic.fallbackCount;
  }
  if (record.stage === "preflight-failed") {
    h.preflightErrors = record.preflight.total;
    h.preflightFamilies = record.preflight.familyCount;
    return h;
  }
  h.blockers = record.blockers.total;
  h.loweringDiagnostics = record.blockers.loweringDiagnostics;
  // null while the module did not lower: the wall is unmeasured, never zero.
  h.postLoweringDiagnostics = record.blockers.postLoweringDiagnostics ?? null;
  h.fences = record.fences.total;
  h.fencesDirect = record.fences.direct;
  h.fencesCascades = record.fences.cascades.total;
  h.fencesFirstParty = record.fences.firstParty;
  h.fencesThirdParty = record.fences.thirdParty;
  if (record.fences.bySite) {
    h.fencesModuleInit = record.fences.bySite.moduleInit;
    h.fencesFunction = record.fences.bySite.function;
  }
  h.fenceFamilies = record.fences.familyCount;
  h.statements = record.statements.total;
  h.statementsFailed = record.statements.failed;
  h.passingPct = record.statements.passingPct;
  if (record.unreached) {
    h.unreachedStatements = record.unreached.statements;
    h.unreachedFailed = record.unreached.failed;
    h.unreachedFences = record.unreached.fences.total;
    h.unreachedDiagnostics = record.unreached.diagnostics.total;
    h.functionsSkipped = record.unreached.functionsSkipped;
  }
  return h;
}

/** Every headline metric that changed between two records. */
export function diffHeadline(before, after) {
  const b = headline(before);
  const a = headline(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const rows = [];
  for (const key of keys) {
    const from = b[key] ?? null;
    const to = a[key] ?? null;
    if (from === to) continue;
    if (key === "elapsedMs") continue; // wall time is reported, never a delta line
    rows.push({ metric: key, before: from, after: to, delta: typeof from === "number" && typeof to === "number" ? to - from : null });
  }
  return rows;
}

const fmt = (v) => (v === null || v === undefined ? "-" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));

/** A delta side: the post-lowering wall reads "unmeasured" (not "-") while
 * the module did not lower. */
const fmtMetric = (metric, v) => (v === null && metric === "postLoweringDiagnostics" ? "unmeasured" : fmt(v));

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => fmt(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? fmt(c).padEnd(widths[i]) : fmt(c).padStart(widths[i]))).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

/** The one-screen view: a row per entry plus, per entry, the headline
 * deltas against its committed record and the preflight families of a
 * preflight-failed entry. */
export function renderLedger(records, committed = new Map()) {
  const out = [];
  const headers = ["entry", "stage", "blockers", "diags", "post", "fences", "init", "cascade", "1st/3rd", "stmts", "failed", "pass%", "unreached", "un.diags", "un.fences", "sources", "npm s/f", "ms"];
  const rows = records.map((r) => {
    if (r.stage === "unavailable" || r.stage === "crashed") {
      return [r.name, r.stage, "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", r.elapsedMs ?? "-"];
    }
    const npm = r.npmStatic ? `${r.npmStatic.static}/${r.npmStatic.fallbackCount}` : "-";
    if (r.stage === "preflight-failed") {
      return [r.name, r.stage, "-", `${r.preflight.total} TS`, "-", "-", "-", "-", `${r.preflight.firstParty}/${r.preflight.thirdParty}`, "0", "-", "-", "-", "-", "-", r.sources, npm, r.elapsedMs];
    }
    const init = r.fences.bySite ? r.fences.bySite.moduleInit : "-";
    // A frontier total is a floor (see the footnote), so it prints as "N+".
    const blockers = r.blockers.atLeast ? `${r.blockers.total}+` : r.blockers.total;
    return [
      r.name, r.stage, blockers, r.blockers.loweringDiagnostics, r.blockers.postLoweringDiagnostics ?? null, r.fences.total,
      init, r.fences.cascades.total, `${r.fences.firstParty}/${r.fences.thirdParty}`, r.statements.total, r.statements.failed, r.statements.passingPct,
      r.unreached ? r.unreached.statements : "-", r.unreached ? r.unreached.diagnostics.total : "-", r.unreached ? r.unreached.fences.total : "-", r.sources, npm, r.elapsedMs,
    ];
  });
  out.push(table(headers, rows));
  out.push("");
  out.push("blockers = lowering diagnostics + reached runtime fences: what a no-engine build must clear (each reached fence is an SC3003 once lowering is clean).");
  out.push("N+ = a floor: at a frontier, code behind a failing statement is not measured and IR validation/backend checks (post, shown as -) do not run until the module lowers.");
  out.push("init = fences recorded in module top-level initialisation, a lower bound on startup: top-level IIFEs and class static/field initialisers count as function bodies, and a lazily required module initialises at its require.");
  out.push("1st/3rd = fences in first-party code (program files outside node_modules plus the entry's declared first-party packages) versus every other package; un.diags/un.fences = blockers/fences in code the entry path does not reach.");
  const uncommitted = records.filter((r) => !committed.has(r.name)).map((r) => r.name);
  for (const r of records) {
    if (r.stage === "unavailable") {
      out.push("");
      out.push(`${r.name}: unavailable — ${r.unavailable}`);
    } else if (r.stage === "crashed") {
      out.push("");
      out.push(`${r.name}: crashed — ${r.crashed.name}: ${r.crashed.message}`);
    } else if (r.stage === "preflight-failed") {
      out.push("");
      out.push(`${r.name}: preflight failed — ${r.preflight.total} TypeScript error${r.preflight.total === 1 ? "" : "s"} in ${r.preflight.familyCount} famil${r.preflight.familyCount === 1 ? "y" : "ies"}:`);
      for (const f of r.preflight.families) {
        const variants = Object.entries(f.variants).map(([v, n]) => `${v || "(none)"} ×${n}`).join(", ");
        out.push(`  ×${String(f.count).padEnd(4)} ${f.pattern}  [${f.code}] ${variants ? `(${variants})` : ""}`);
      }
    }
    const previous = committed.get(r.name);
    if (previous === undefined) continue;
    const delta = diffHeadline(previous, r);
    out.push("");
    if (delta.length === 0) {
      out.push(`${r.name}: no headline change vs committed record${previous.generatedAt ? ` (${previous.generatedAt})` : ""}`);
      continue;
    }
    out.push(`${r.name}: vs committed record${previous.generatedAt ? ` (${previous.generatedAt})` : ""}:`);
    for (const d of delta) {
      const sign = d.delta === null ? "" : d.delta > 0 ? `+${d.delta}` : String(d.delta);
      out.push(`  ${sign.padStart(7)}  ${d.metric}  (${fmtMetric(d.metric, d.before)} → ${fmtMetric(d.metric, d.after)})`);
    }
  }
  if (uncommitted.length > 0) {
    out.push("");
    out.push(`no committed record yet for ${uncommitted.join(", ")} (--write stores the baseline under tests/dogfood/ledger/)`);
  }
  return out.join("\n");
}
