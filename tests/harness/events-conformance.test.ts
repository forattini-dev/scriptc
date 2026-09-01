/**
 * Matrix conformance for the node:events / EventEmitter slice.
 *
 * The compatibility profile is compiler input, not test-only metadata: its
 * rows project into the shipped surface manifest. This suite holds the
 * profile to the same four things the URL suite holds its own profile to:
 *
 *  - the running runtime IS one of the profile's declared targets — the
 *    suite selects the target from the host rather than demanding one
 *    particular pin, so it is green under every first-class Node and red
 *    only on a runtime the matrix does not declare at all;
 *  - the REFLECTED census of EventEmitter — statics, prototype, and the
 *    own properties of a constructed instance — equals the declared
 *    inventory member for member, the tripwire that makes a Node upgrade
 *    a deliberate profile edit rather than a silent widening;
 *  - every supported row names differential corpus evidence that exists;
 *  - the shipped manifest carries each row with the status and fence the
 *    profile claims.
 *
 * The one thing this suite tests that the URL suite cannot: EventEmitter
 * is NOT a global. Reaching it needs the schema's `sources.resolve`
 * factory, and this is its first real use — so the "census reaches
 * interfaces that are not globals" test below is load-bearing rather than
 * decorative.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  compatEvidenceKey,
  compatRowName,
  compatRowTargetLabel,
  compatTargetLabel,
  NODE24_EVENTS_COMPAT_PROFILE,
  type CompatInventoryPlacement,
  type SurfaceManifest,
} from "@scriptc/compiler";
import {
  activeCompatTarget,
  compatTargetVersions,
  publicSymbolName,
  reflectInterface,
  rowsForTarget,
  wellKnownSymbolNames,
} from "./compat-census.js";

const repoRoot = join(import.meta.dirname, "../..");
const corpusRoot = join(repoRoot, "tests/corpus");
const profile = NODE24_EVENTS_COMPAT_PROFILE;
const inventory = profile.inventory;
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "packages/compiler/surface-manifest.json"), "utf8"),
) as SurfaceManifest;

/** The matrix target this run IS. Every comparison below is made against
 * this target's rows, so the suite is green on Node 24 and on Node 26 and
 * red only on a runtime the profile does not declare at all. */
const target = activeCompatTarget(profile.targets);
const entries = target === null
  ? inventory.entries
  : rowsForTarget(inventory.entries, target);

const membersAt = (owner: string, placement: CompatInventoryPlacement): string[] =>
  entries
    .filter((entry) => entry.owner === owner && entry.placement === placement)
    .map((entry) => entry.member)
    .sort();

/** Corpus programs carry every suffix the differential runner accepts. */
function corpusExists(name: string): boolean {
  return [".ts", ".mts", ".cjs", ".mjs", ".js"].some((suffix) =>
    existsSync(join(corpusRoot, `${name}${suffix}`)),
  );
}

describe("EventEmitter compatibility profile", () => {
  test("the running runtime is one of the declared matrix targets", () => {
    // The primary is what .node-version pins; the candidates are equally
    // supported runtimes, each with its own reflected census.
    const pinnedNode = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
    expect(profile.targets.primary.node).toBe(pinnedNode);
    expect(profile.targets.candidates.length).toBeGreaterThan(0);

    // Selection, not equality: the only failure this can produce is a host
    // outside the whole matrix. Running on any declared target is green.
    expect(
      target,
      `Node ${process.versions.node} is not a declared target of the events profile ` +
        `(declared: ${compatTargetVersions(profile.targets)}) — add it to the ` +
        `matrix with its own reflected census, or run the suite under one of them`,
    ).not.toBeNull();
  });

  test("the inventory classifies every supported row and every gap", () => {
    const supported = profile.operations.map((row) => row.id).sort();
    const ids = inventory.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      entries
        .filter((entry) => entry.status === "static")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(supported);

    for (const entry of inventory.entries) {
      if (entry.status === "static") {
        expect(entry.code, `${entry.id}: static rows have no refusal code`).toBeUndefined();
        expect(entry.reason, `${entry.id}: static rows are explained by evidence`).toBeUndefined();
      } else if (entry.status === "dynamic-only" || entry.status === "unsupported") {
        // The fence is per row, and both codes here were verified by
        // COMPILING a probe rather than by reading the lowering: a member
        // the standard library types declare but nothing lowers raises
        // SC2020, while Node's pre-private-field internals and the
        // class-value reads that nothing claims at all raise SC1090.
        expect(["SC2020", "SC1090"], `${entry.id}: unexpected fence`).toContain(entry.code);
        expect(entry.reason?.length, `${entry.id}: missing gap rationale`).toBeGreaterThan(0);
      } else {
        expect(entry.code, `${entry.id}: exclusions are not refusal claims`).toBeUndefined();
        expect(entry.reason?.length, `${entry.id}: missing scope rationale`).toBeGreaterThan(0);
      }
    }

    expect(inventory.entries.some((entry) => entry.status === "unsupported")).toBe(true);
    expect(inventory.entries.some((entry) => entry.status === "out-of-scope")).toBe(true);
    expect(inventory.entries.some((entry) => entry.code === "SC1090")).toBe(true);
    // Compiled emitters are engine-free: the island's emulated
    // EventEmitter is a different class, so nothing here is reachable
    // through the dynamic engine that is not already lowered statically.
    expect(inventory.entries.some((entry) => entry.status === "dynamic-only")).toBe(false);
    expect(inventory.excludedInterfaces.length).toBeGreaterThan(0);
    for (const exclusion of inventory.excludedInterfaces) {
      expect(exclusion.name.length).toBeGreaterThan(0);
      expect(exclusion.reason.length).toBeGreaterThan(0);
    }
  });

  test("the reflected interfaces match the complete public census", () => {
    for (const owner of inventory.interfaces) {
      const source = inventory.sources?.[owner];
      const actual = reflectInterface(owner, source);
      const declaredConstructors = entries.filter(
        (entry) => entry.owner === owner && entry.placement === "constructor",
      ).length;
      expect(declaredConstructors, `${owner}: constructor classification`).toBe(
        source?.prototype === undefined ? 1 : 0,
      );
      expect(actual.statics.sort(), `${owner}: static members`).toEqual(
        membersAt(owner, "static"),
      );
      expect(actual.prototype.sort(), `${owner}: own prototype members`).toEqual(
        membersAt(owner, "prototype"),
      );
      expect(actual.inherited.sort(), `${owner}: inherited prototype members`).toEqual(
        membersAt(owner, "prototype-inherited"),
      );
      expect(actual.symbols.sort(), `${owner}: public symbol members`).toEqual(
        membersAt(owner, "prototype-symbol"),
      );
      expect(actual.setters.sort(), `${owner}: writable components`).toEqual(
        membersAt(owner, "prototype-setter"),
      );
      expect(actual.instance.sort(), `${owner}: own instance properties`).toEqual(
        membersAt(owner, "instance"),
      );
    }
  });

  test("the public-symbol classifier covers every well-known symbol", () => {
    const known = wellKnownSymbolNames();
    expect(known.size).toBeGreaterThan(0);
    for (const [symbol, name] of known) {
      expect(publicSymbolName(symbol)).toBe(name);
    }
    expect(publicSymbolName(Symbol("nodejs.private"))).toBeNull();
  });

  test("the census reaches an interface that is not a global", async () => {
    // EventEmitter has no global name: without the profile's `resolve`
    // factory the census could not see the interface at all, which is
    // exactly the surface an allowlist would otherwise miss. This is the
    // first profile in the registry to need that factory.
    expect(inventory.interfaces).toEqual(["EventEmitter"]);
    expect((globalThis as Record<string, unknown>)["EventEmitter"]).toBeUndefined();
    const source = inventory.sources?.["EventEmitter"];
    expect(source?.resolve).toBeTypeOf("function");
    expect(source?.instance).toBeTypeOf("function");

    // And the reason the module and the class census are the same thing:
    // Node does `module.exports = EventEmitter`, so the module object IS
    // the class. Any future Node that splits them makes this fail.
    const events = await import("node:events");
    expect(source!.resolve!()).toBe(events.default);
    expect(events.default).toBe(events.EventEmitter);
  });

  test("Node's pre-private-field internals are declared at both placements", () => {
    // EventEmitter predates private fields: _events/_eventsCount/
    // _maxListeners are ENUMERABLE own properties of the prototype AND,
    // after EventEmitter.init runs, of every instance. An empty instance
    // census would be a lie here, so the profile declares the same three
    // members twice, once per placement.
    const internals = ["_events", "_eventsCount", "_maxListeners"];
    expect(membersAt("EventEmitter", "instance")).toEqual(internals);
    expect(membersAt("EventEmitter", "prototype")).toEqual(
      expect.arrayContaining(internals),
    );
    for (const member of internals) {
      const onPrototype = inventory.entries.find(
        (entry) => entry.placement === "prototype" && entry.member === member,
      );
      const onInstance = inventory.entries.find(
        (entry) => entry.placement === "instance" && entry.member === member,
      );
      expect(onPrototype?.status, `${member}: prototype status`).toBe("unsupported");
      expect(onInstance?.status, `${member}: instance status`).toBe("unsupported");
      expect(onPrototype?.code).toBe("SC1090");
      expect(onInstance?.code).toBe("SC1090");
    }
  });

  test("names that sit at two placements publish distinctly", () => {
    // Node's module object IS the class, so a handful of names exist both
    // as a class-value static and as a prototype member — with opposite
    // statuses. The manifest must never carry one name twice; a bare
    // compatRowName would do exactly that, which is what `publishAs` is
    // for. This is the invariant that catches a future row forgetting it.
    const shared = ["once", "on", "listenerCount", "getMaxListeners", "setMaxListeners"];
    for (const member of shared) {
      const placements = inventory.entries
        .filter((entry) => entry.member === member)
        .map((entry) => entry.placement)
        .sort();
      expect(placements, `${member}: expected both placements`).toEqual([
        "prototype",
        "static",
      ]);
    }
    const published = [
      ...profile.operations.map((row) => row.name),
      ...inventory.entries
        .filter((entry) => entry.status !== "static" && entry.status !== "out-of-scope")
        .map(compatRowName),
    ];
    expect(new Set(published).size, "duplicate published names").toBe(published.length);
  });

  test("every row has unique ids and resolvable corpus evidence", () => {
    expect(profile.schemaVersion).toBe(1);
    const ids = profile.operations.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Two members are named the same on the class value and on the
    // prototype (setMaxListeners); they are separate claims with separate
    // ids, and the manifest publishes them under distinct names.
    const names = profile.operations.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);

    for (const row of profile.operations) {
      expect(row.facets.length, `${row.id}: missing facets`).toBeGreaterThan(0);
      expect(row.scope?.length, `${row.id}: missing supported scope`).toBeGreaterThan(0);
      expect(row.evidence.length, `${row.id}: missing differential evidence`).toBeGreaterThan(0);
      for (const evidence of row.evidence) {
        const key = compatEvidenceKey(evidence);
        expect(evidence.corpus, `${row.id}: ${key} is not corpus evidence`).toBeDefined();
        expect(corpusExists(evidence.corpus!), `${row.id}: missing ${key}`).toBe(true);
      }
    }
  });

  // The manifest is a shipped artifact, not a per-host one: it carries
  // every row of the matrix whatever runtime generated it, so this test
  // compares against the WHOLE inventory rather than the active target's
  // slice, and each row against the label its own targets produce.
  test("the shipped manifest carries every projected row", () => {
    const published = new Map(manifest.entries.map((entry) => [entry.id, entry]));
    const primaryLabel = compatTargetLabel(profile.targets.primary);
    expect(primaryLabel).toBe(`Node ${profile.targets.primary.node}`);

    for (const operation of profile.operations) {
      const entry = published.get(operation.id);
      expect(entry, `${operation.id} is missing from the manifest`).toBeDefined();
      expect(entry!.status, `${operation.id}: manifest status`).toBe("static");
      expect(entry!.name).toBe(operation.name);
      expect(entry!.note).toContain(primaryLabel);
      for (const evidence of operation.evidence) {
        expect(entry!.note).toContain(compatEvidenceKey(evidence));
      }
    }

    for (const row of inventory.entries) {
      const entry = published.get(row.id);
      if (row.status === "out-of-scope") {
        // Exclusions stay in the profile: the manifest publishes claims,
        // not the deliberate silences behind them.
        expect(entry, `${row.id}: out-of-scope rows are not projected`).toBeUndefined();
        continue;
      }
      if (row.status === "static") continue;
      expect(entry, `${row.id} is missing from the manifest`).toBeDefined();
      expect(entry!.status, `${row.id}: manifest status`).toBe(row.status);
      expect(entry!.code, `${row.id}: manifest fence`).toBe(row.code);
      expect(entry!.name).toBe(compatRowName(row));
      expect(entry!.note).toBe(
        `${compatRowTargetLabel(profile.targets, row)}; ${row.reason}`,
      );
    }
  });
});
